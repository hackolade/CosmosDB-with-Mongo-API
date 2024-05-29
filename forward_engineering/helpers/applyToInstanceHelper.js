const vm = require('vm');
const bson = require('bson');
const connectionHelper = require('../../reverse_engineering/helpers/connectionHelper');
const readNdJsonByLine = require('./ndJsonHelper');

const applyToInstanceHelper = {
	async applyToInstance(data, logger, cb) {
		let connection;

		try {
			if (!data.containerData?.[0]?.dbId) {
				throw new Error('Database Id is required. Please, set it on the collection properties pane.');
			}

			connection = await connect(data, logger);

			const collectionName = data.containerData?.[0]?.code || data.containerData?.[0]?.name;
			const { scriptWithSamples, numberOfSamples } = await generateScriptForInsertingDataInBulk(
				data.script,
				collectionName,
				data.entitiesData,
				logger,
			);
			const mongodbScript = replaceUseCommand(convertBson(scriptWithSamples));
			await runMongoDbScript({
				mongodbScript,
				logger,
				connection,
				numberOfSamples,
			});

			connection.close();
			cb(null);
		} catch (error) {
			error = {
				message: error.message,
				stack: error.stack,
			};
			logger.log('error', error);

			if (connection) {
				connection.close();
			}

			cb(error);
		}
	},

	testConnection(connectionInfo, logger, cb) {
		connect(connectionInfo, logger).then(
			connection => {
				connection.close();
				cb(false);
			},
			error => {
				cb(true);
			},
		);
	},
};

const connect = (connectionInfo, logger) => {
	logger.clear();
	logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);

	return connectionHelper
		.connect(connectionInfo)
		.then(connection => {
			logger.log('info', { message: 'successfully connected' });

			return connection;
		})
		.catch(error => {
			logger.log('error', {
				message: error.message,
				stack: error.stack,
				error,
			});

			return Promise.reject(error);
		});
};

const replaceUseCommand = script => {
	return script
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const useStatement = /^use\ ([\s\S]+);$/i;
			const result = line.match(useStatement);

			if (!result) {
				return line;
			}

			return `useDb("${result[1]}");`;
		})
		.join('\n');
};

const runMongoDbScript = ({ mongodbScript, logger: loggerInstance, connection, numberOfSamples }) => {
	let currentDb;
	let commands = [];
	let insertedSamples = 0;
	let prevInsertingProgress = 0;
	const logger = createLogger(loggerInstance);

	logger.info('Start applying instance ...');

	const context = {
		ISODate: d => new Date(d),
		ObjectId: bson.ObjectId,
		Binary: bson.Binary,
		MinKey: bson.MinKey,
		MaxKey: bson.MaxKey,
		Code: bson.Code,

		useDb(dbName) {
			currentDb = dbName;
		},

		db: {
			getCollection(collectionName) {
				const db = connection.db(currentDb);
				const collection = db.collection(collectionName);

				return {
					createIndex(fields, params = {}) {
						const indexName = params.unique ? 'unique' : params.name || '';
						const command = () =>
							collection.createIndex(fields, params).then(
								() => {
									logger.info(`index ${indexName} created`);
								},
								error => {
									const errMessage = `index ${indexName} not created`;
									logger.error(error, errMessage);
									error.message = errMessage;

									return Promise.reject(error);
								},
							);

						commands.push(command);
					},
					insert(data) {
						const command = () =>
							collection
								.insertOne(data)
								.then(() => {
									insertedSamples++;
									const insertingProgress = Math.round((insertedSamples / numberOfSamples) * 100);
									if (insertingProgress - prevInsertingProgress < 5) {
										return;
									}
									prevInsertingProgress = insertingProgress;

									logger.info(`Inserting Samples: ${insertingProgress}%`);
								})
								.catch(error => {
									const errMessage = `sample is not inserted ${insertedSamples} / ${numberOfSamples} Reason: ${error.message}`;
									logger.error(error, errMessage);
									error.message = errMessage;

									return Promise.reject(error);
								});

						commands.push(command);
					},
				};
			},
			runCommand(commandData) {
				const db = connection.db(currentDb);

				const command = () =>
					db
						.command(commandData)
						.then(() => {
							logger.info('Create sharding');
						})
						.catch(error => {
							const doesShardingExist = error.codeName === 'NamespaceExists' || error.code === 9;
							if (doesShardingExist) {
								logger.warning('shard key is not created:  ' + error.message, error);
							} else {
								const errMessage = 'error of creation sharding';
								logger.error(error, errMessage);
								error.message = errMessage + ': ' + error.message;

								return Promise.reject(error);
							}
						});

				commands.push(command);
			},
		},
	};

	vm.createContext(context);
	vm.runInContext(mongodbScript, context);

	return commands.reduce((prev, next) => {
		return prev.then(() => next());
	}, Promise.resolve());
};

const generateScriptForInsertingDataInBulk = async (script, collectionName, entitiesData, logger) => {
	let numberOfSamples = Object.keys(entitiesData).length;
	const scriptWithSamples = await Object.values(entitiesData).reduce(
		async (resultScript, entityData) => {
			resultScript = await resultScript;

			if (!entityData.filePath) {
				return Promise.resolve(resultScript);
			}

			try {
				const documents = await readNdJsonByLine(entityData.filePath, logger);
				numberOfSamples += documents.length;

				return (
					resultScript +
					documents.map(document => `db.getCollection("${collectionName}").insert(${document});`).join('\n\n')
				);
			} catch (error) {
				logger.log('error', error, 'Error during publishing fake data in bulk');
			}
		},
		Promise.resolve(script + '\n\n'),
	);

	return { scriptWithSamples, numberOfSamples };
};

const createLogger = logger => ({
	info(message) {
		logger.progress({
			message: `${message}`,
		});
		logger.log('info', {
			message,
		});
	},
	error(error, message) {
		logger.progress({
			message: `[color:red]failed: ${message}`,
		});
		logger.log(
			'error',
			{
				message: error.message,
				stack: error.stack,
			},
			message,
		);
	},
	warning(message, error) {
		logger.progress({
			message: `[color:orange]warning: ${message}`,
		});
		if (error) {
			logger.log(
				'error',
				{
					message: error.message,
					stack: error.stack,
				},
				message,
			);
		}
	},
});

function convertBson(sample) {
	return sample
		.replace(/\{\s*\"\$minKey\": (\d*)\s*\}/gi, 'MinKey($1)')
		.replace(/\{\s*\"\$maxKey\": (\d*)\s*\}/gi, 'MaxKey($1)');
}

module.exports = applyToInstanceHelper;
