'use strict';

const async = require('async');
const _ = require('lodash');
const CosmosClient = require('./CosmosClient');
const connectionHelper = require('./helpers/connectionHelper');

const ERROR_CONNECTION = 1;
const ERROR_DB_LIST = 2;
const ERROR_DB_CONNECTION = 3;
const ERROR_LIST_COLLECTION = 4;
const ERROR_GET_DATA = 5;
const ERROR_HANDLE_BUCKET = 6;
const ERROR_COLLECTION_DATA = 7;

module.exports = {
	connect: function(connectionInfo, logger, cb){
		logger.clear();
		logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);

		connectionHelper.connect(connectionInfo)
			.then(connection => cb(null, connection))
			.catch(err => {
				logger.log('error', [params, err], "Connection error");
				return cb(createError(ERROR_CONNECTION, err));
			});
	},

	disconnect: function(connectionInfo, logger, cb){
		cb()
	},

	testConnection: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, (err, result) => {
			if (err) {
				cb(true);
			} else {
				cb(false);
				result.close();
			}
		});
	},

	getDatabases: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				return cb(err);
			} else {
				const db = connection.db();
				db.admin().listDatabases((err, dbs) => {
					if(err) {
						logger.log('error', err);
						connection.close();
						return cb(createError(ERROR_DB_LIST, err));
					} else {
						dbs = dbs.databases.map(item => item.name);
						logger.log('info', dbs, 'All databases list', connectionInfo.hiddenKeys);
						connection.close();
						return cb(null, dbs);
					}
				});
			}
		});
	},

	getDocumentKinds: function(connectionInfo, logger, cb) {		
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				console.log(err);
			} else {
				const db = connection.db(connectionInfo.database);
				
				if (!db) {
					connection.close();
					return cb(createError(ERROR_DB_CONNECTION, `Failed connection to database ${connectionInfo.database}`));
				}

				db.listCollections().toArray((err, collections) => {
					if (err) {
						logger.log('error', err);
						connection.close();
						cb(createError(ERROR_LIST_COLLECTION, err));
					} else {
						collections = connectionInfo.includeSystemCollection ? collections : filterSystemCollections(collections);
						logger.log('info', collections, 'Mapped collection list');

						async.map(collections, (collectionData, collItemCallback) => {
							const collection = db.collection(collectionData.name);

							getData(collection, connectionInfo.recordSamplingSettings, function (err, documents) {
								if (err) {
									logger.log('error', err);
									return collItemCallback(err, null);
								} else {
									logger.log('info', { collectionItem: collectionData.name }, 'Getting documents for current collectionItem', connectionInfo.hiddenKeys);
									
									documents  = filterDocuments(documents);
									let inferSchema = generateCustomInferSchema(documents, { sampleSize: 20 });
									let documentsPackage = getDocumentKindDataFromInfer({ 
										bucketName: collectionData.name,
										inference: inferSchema, 
										isCustomInfer: true, 
										excludeDocKind: connectionInfo.excludeDocKind 
									}, 90);

									return collItemCallback(err, documentsPackage);
								}
							});
						}, (err, items) => {
							if(err){
								logger.log('error', err);
							}

							connection.close();		
							return cb(createError(ERROR_GET_DATA, err), items);
						});
					}
				});
			}			
		});
	},

	getDbCollectionsNames: function(connectionInfo, logger, cb) {
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				return cb(err)
			} else {
				const db = connection.db(connectionInfo.database);
				
				if (!db) {
					connection.close();
					return cb(createError(ERROR_DB_CONNECTION, `Failed connection to database ${connectionInfo.database}`));
				}

				logger.log('info', { Database: connectionInfo.database }, 'Getting collections list for current database', connectionInfo.hiddenKeys);
				
				db.listCollections().toArray((err, collections) => {
					if(err){
						logger.log('error', err);
						connection.close();
						return cb(createError(ERROR_LIST_COLLECTION, err));
					} else {
						let collectionNames = (connectionInfo.includeSystemCollection ? collections : filterSystemCollections(collections)).map(item => item.name);
						logger.log('info', collectionNames, "Collection list for current database", connectionInfo.hiddenKeys);
						handleBucket(connectionInfo, collectionNames, db, function (err, items) {
							connection.close();
							if (err) {
								cb(err);
							} else {
								cb(null, items);
							}
						});
					}
				});
			}
		});
	},

	getDbCollectionsData: function(data, logger, cb){
		let includeEmptyCollection = data.includeEmptyCollection;
		let { recordSamplingSettings, fieldInference } = data;
		logger.progress = logger.progress || (() => {});
		logger.log('info', getSamplingInfo(recordSamplingSettings, fieldInference), 'Reverse-Engineering sampling params', data.hiddenKeys);

		let bucketList = data.collectionData.dataBaseNames;

		logger.log('info', { CollectionList: bucketList }, 'Selected collection list', data.hiddenKeys);

		const cosmosClient = new CosmosClient(data.database, data.host, data.password, data.isLocal);

		this.connect(data, logger, async (err, connection) => {
			if (err) {
				logger.progress({ message: 'Error of connecting to the instance.\n ' + err.message, containerName: data.database, entityName: '' });											
				logger.log('error', err);
				return cb(err);
			}
			
			try {
				const db = connection.db(data.database);

				if (!db) {
					connection.close();
					let error = `Failed connection to database ${data.database}`;
					logger.log('error', error);
					logger.progress({ message: 'Error of connecting to the database .\n ' + data.database, containerName: data.database, entityName: '' });											
					return cb(createError(ERROR_DB_CONNECTION, error));
				}

				let modelInfo = {
					accountID: data.password,
					version: []
				};

				await Promise.all([
					getBuildInfo(db).catch(err => {
						logger.progress({ message: 'Error while getting version: ' + err.message, containerName: data.database, entityName: '' });
						logger.log('error', err);
					}),
					data.includeAccountInformation
						? cosmosClient.getAdditionalAccountInfo(data).catch(err => {
							logger.progress({ message: 'Error while getting control pane data: ' + err.message, containerName: data.database, entityName: '' });
							logger.log('error', err);

							return {};
						})
						: Promise.resolve({}),
				]).then(([ buildInfo, controlPaneData ]) => {
					modelInfo = {
						...modelInfo,
						...controlPaneData,
						version: buildInfo.version,
					}
				});

				async.map(bucketList, (bucketName, collItemCallback) => {
					const collection = db.collection(bucketName);
					logger.progress({ message: 'Collection data loading ...', containerName: data.database, entityName: bucketName });											

					getBucketInfo(db, cosmosClient, bucketName, (err) => {
						logger.progress({ message: 'Error of getting collection data .\n ' + err.message, containerName: data.database, entityName: bucketName });											
						logger.log('error', err);
					}, (err, bucketInfo = {}) => {
						if (err) {
							logger.progress({ message: 'Error of getting collection data .\n ' + err.message, containerName: data.database, entityName: bucketName });											
							logger.log('error', err);
						}

						bucketInfo = {
							...bucketInfo,
							dbId: data.database,
						};

						logger.progress({ message: 'Collection data has loaded', containerName: data.database, entityName: bucketName });											
						logger.progress({ message: 'Loading documents...', containerName: data.database, entityName: bucketName });											

						getData(collection, recordSamplingSettings, (err, documents) => {
							if(err) {
								logger.progress({ message: 'Error of loading documents.\n ' + err.message, containerName: data.database, entityName: bucketName });											
								logger.log('error', err);
								return collItemCallback(err, null);
							} else {
								logger.progress({ message: 'Documents have loaded', containerName: data.database, entityName: bucketName });											

								documents  = filterDocuments(documents);
								let documentKindName = data.documentKinds[bucketName].documentKindName || '*';
								let docKindsList = data.collectionData.collections[bucketName];
								let collectionPackages = [];										

								if (documentKindName !== '*') {
									if(!docKindsList) {
										if (includeEmptyCollection) {
											let documentsPackage = {
												dbName: bucketName,
												emptyBucket: true,
												indexes: [],
												bucketIndexes: [],
												views: [],
												validation: false,
												bucketInfo
											};

											collectionPackages.push(documentsPackage)
										}
									} else {
										docKindsList.forEach(docKindItem => {
											let newArrayDocuments = documents.filter((item) => {
												return item[documentKindName] == docKindItem;
											});

											let documentsPackage = {
												dbName: bucketName,
												collectionName: docKindItem,
												documents: newArrayDocuments || [],
												indexes: [],
												bucketIndexes: [],
												views: [],
												validation: false,
												docType: documentKindName,
												bucketInfo
											};

											if(fieldInference.active === 'field') {
												documentsPackage.documentTemplate = newArrayDocuments[0] || null;
											}
											if (documentsPackage.documents.length > 0 || includeEmptyCollection) {
												collectionPackages.push(documentsPackage)
											}
										});
									}
								} else {
									let documentsPackage = {
										dbName: bucketName,
										collectionName: bucketName,
										documents: documents || [],
										indexes: [],
										bucketIndexes: [],
										views: [],
										validation: false,
										docType: bucketName,
										bucketInfo
									};

									if(fieldInference.active === 'field'){
										documentsPackage.documentTemplate = documents[0] || null;
									}
									if (documentsPackage.documents.length > 0 || includeEmptyCollection) {
										collectionPackages.push(documentsPackage);
									}
								}

								return collItemCallback(err, collectionPackages);
							}
						});
					});
				}, (err, items) => {
					if(err){
						logger.log('error', err);
					}
					connection.close();
					return cb(createError(ERROR_COLLECTION_DATA, err), items, modelInfo);
				});
			} catch (err) {
				if(err){
					logger.log('error', err);
				}
				connection.close();
				return cb(createError(ERROR_COLLECTION_DATA, err));
			}
		});
	}
};

function getBuildInfo(db) {
	return new Promise((resolve, reject) => {
		db.admin().buildInfo((err, info) => {
			if (err) {
				reject(err);
			} else {
				resolve(info);
			}
		});
	});
}

function getSamplingInfo(recordSamplingSettings, fieldInference){
	let samplingInfo = {};
	let value = recordSamplingSettings[recordSamplingSettings.active].value;
	let unit = (recordSamplingSettings.active === 'relative') ? '%' : ' records max';
	samplingInfo.recordSampling = `${recordSamplingSettings.active} ${value}${unit}`
	samplingInfo.fieldInference = (fieldInference.active === 'field') ? 'keep field order' : 'alphabetical order';
	return samplingInfo;
}

function handleBucket(connectionInfo, collectionNames, database, dbItemCallback){
	async.map(collectionNames, (collectionName, collItemCallback) => {
		const collection = database.collection(collectionName);
		if (!collection) {
			return collItemCallback(`Failed got collection ${collectionName}`);
		}

		getData(collection, connectionInfo.recordSamplingSettings, (err, documents) => {
			if(err){
				return collItemCallback(err);
			} else {
				documents  = filterDocuments(documents);
				let documentKind = connectionInfo.documentKinds[collectionName].documentKindName || '*';
				let documentTypes = [];

				if (documentKind !== '*') {
					documentTypes = documents.map(function(doc){
						return doc[documentKind];
					});
					documentTypes = documentTypes.filter((item) => Boolean(item));
					documentTypes = _.uniq(documentTypes);
				}

				let dataItem = prepareConnectionDataItem(documentTypes, collectionName, database, documents.length === 0);
				return collItemCallback(err, dataItem);
			}
		});
	}, (err, items) => {
		return dbItemCallback(createError(ERROR_HANDLE_BUCKET, err), items);
	});
}

function prepareConnectionDataItem(documentTypes, bucketName, database, isEmpty){
	let uniqueDocuments = _.uniq(documentTypes);
	let connectionDataItem = {
		dbName: bucketName,
		dbCollections: uniqueDocuments,
		isEmpty
	};

	return connectionDataItem;
}

function generateCustomInferSchema(documents, params) {
	function typeOf(obj) {
		return {}.toString.call(obj).split(' ')[1].slice(0, -1).toLowerCase();
	};

	let sampleSize = params.sampleSize || 30;

	let inferSchema = {
		"#docs": 0,
		"$schema": "http://json-schema.org/schema#",
		"properties": {}
	};

	documents.forEach(item => {
		inferSchema["#docs"]++;
		
		for(let prop in item){
			if(inferSchema.properties.hasOwnProperty(prop)){
				inferSchema.properties[prop]["#docs"]++;
				inferSchema.properties[prop]["samples"].indexOf(item[prop]) === -1 && inferSchema.properties[prop]["samples"].length < sampleSize? inferSchema.properties[prop]["samples"].push(item[prop]) : '';
				inferSchema.properties[prop]["type"] = typeOf(item[prop]);
			} else {
				inferSchema.properties[prop] = {
					"#docs": 1,
					"%docs": 100,
					"samples": [item[prop]],
					"type": typeOf(item[prop])
				}
			}
		}
	});

	for (let prop in inferSchema.properties){
		inferSchema.properties[prop]["%docs"] = Math.round((inferSchema.properties[prop]["#docs"] / inferSchema["#docs"] * 100), 2);
	}
	return inferSchema;
}

function getDocumentKindDataFromInfer(data, probability){
	let suggestedDocKinds = [];
	let otherDocKinds = [];
	let documentKind = {
		key: '',
		probability: 0	
	};

	if(data.isCustomInfer){
		let minCount = Infinity;
		let inference = data.inference.properties;

		for(let key in inference){
			if (typeof inference[key].samples[0] === 'object') {
				continue;
			}

			if(inference[key]["%docs"] >= probability && inference[key].samples.length){
				suggestedDocKinds.push(key);

				if(data.excludeDocKind.indexOf(key) === -1){
					if (inference[key]["%docs"] === documentKind.probability && documentKind.key === 'type') {
						continue;
					}
					
					if(inference[key]["%docs"] >= documentKind.probability && inference[key].samples.length < minCount){
						minCount = inference[key].samples.length;
						documentKind.probability = inference[key]["%docs"];
						documentKind.key = key;
					}
				}
			} else {
				otherDocKinds.push(key);
			}
		}
	} else {
		let flavor = (data.flavorValue) ? data.flavorValue.split(',') : data.inference[0].Flavor.split(',');
		if(flavor.length === 1){
			suggestedDocKinds = Object.keys(data.inference[0].properties);
			let matсhedDocKind = flavor[0].match(/([\s\S]*?) \= "?([\s\S]*?)"?$/);
			documentKind.key = (matсhedDocKind.length) ? matсhedDocKind[1] : '';
		}
	}

	let documentKindData = {
		bucketName: data.bucketName,
		documentList: suggestedDocKinds,
		documentKind: documentKind.key,
		preSelectedDocumentKind: data.preSelectedDocumentKind,
		otherDocKinds
	};

	return documentKindData;
}

function filterDocuments(documents){
	return documents.map(item =>{
		for(let prop in item) {
			if(prop && prop[0] === '_') {
				delete item[prop];
			}
		}
		return item;
	});
}

function filterSystemCollections(collections) {
	const listExcludedCollections = ["system.indexes"];

	return collections.filter((collection) => {
		return collection.name.length < 8 || collection.name.substring(0, 7) !== 'system.';
	});
}

function getSampleDocSize(count, recordSamplingSettings) {
	let per = recordSamplingSettings.relative.value;
	return (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
		: Math.round( count/100 * per);
}

function getData(collection, sampleSettings, callback) {
	collection.countDocuments((err, count) => {
		const amount = !err && count > 0 ? count : 1000;								
		const size = +getSampleDocSize(amount, sampleSettings) || 1000;
		const iterations = size > 1000 ? Math.ceil(size / 1000) : 1;

		asyncLoop(iterations, function (i, callback) {
			const limit = i < iterations - 1 || size % 1000 === 0 ? 1000 : size % 1000;
			
			collection.find().limit(limit).toArray(callback);									
		}, callback);
	});
}

function asyncLoop(iterations, callback, done) {
	let result = [];
	let i = 0; 
	let handler = function (err, data) {
		if (err) {
			done(err);
		} else {
			result = result.concat(data);
			
			if (++i < iterations) {
				callback(i, handler);
			} else {
				done(err, result);
			}
		}
	};

	try {
		callback(i, handler);
	} catch (e) {
		done(e);
	}
}

function createError(code, message) {
	if (!message) {
		return null;
	}
	if (message.code) {
		code = message.code;
	}
	message = message.message || message.msg || message.errmsg || message;

	return {code, message};
}

const getShardingKey = (db, collectionName) => new Promise((resolve, reject) => {
	db.command({
		customAction: 'GetCollection',
		collection: collectionName
	}, (err, result) => {
		if (err) {
			return reject(err);
		}

		if (!result.shardKeyDefinition) {
			return resolve('');
		}

		const shardingKey = Object.keys(result.shardKeyDefinition)[0] || '';

		return resolve(shardingKey);
	});
});

const getAllTypesIndexes = (db, collectionName, shardingKey) => new Promise((resolve, reject) => {
	db.command({
		listIndexes: collectionName
	}, (err, result) => {
		if (err) {
			return reject(err);
		}

		const allIndexes = result?.cursor?.firstBatch || [];

		const uniqueKeys = allIndexes.filter(item => {
			return item.unique;
		}).map((item) => {
			return {
				attributePath: Object.keys(item.key).filter(key => key !== shardingKey)
			};
		});

		const ttlIndex = allIndexes.filter(item => {
			return item.expireAfterSeconds !== undefined;
		}).map((item) => {
			return {
				expireAfterSeconds: item.expireAfterSeconds,
				name: item.name,
				key:  Object.keys(item.key)[0],
			};
		})[0];

		const indexes = allIndexes.filter(index => {
			return !index.unique && index.expireAfterSeconds === undefined;
		}).map(index => {
			const getIndexType = (index) => {
				const isCompound = Object.values(index.key).length > 1;
				const isWildcard = Object.keys(index.key).some(key => key.endsWith('$**'));

				if (isCompound) {
					return 'Compound';
				} else if (isWildcard) {
					return 'Wildcard';
				} else {
					return 'Single Field';
				}
			};
			const type = (indexType) => {
				if (indexType === -1) {
					return 'descending';
				} else if (indexType === '2dsphere') {
					return '2dsphere';
				} else {
					return 'ascending';
				}
			};

			return {
				name: index.name,
				indexType: getIndexType(index),
				indexKey: Object.keys(index.key).map(key => ({
					type: type(index.key[key]),
					name: key.replace(/\.\$\*\*$/, ''),
				}))
			};
		});

		resolve({ uniqueKeys, ttlIndex, indexes });
	});
});

function getBucketInfo(dbInstance, cosmosClient, collectionName, logError, cb) {
	let bucketInfo = {};

	getShardingKey(dbInstance, collectionName)
	.then(result => {
		bucketInfo.shardKey = result;

		return getAllTypesIndexes(dbInstance, collectionName, result);
	}, logError)
	.then(result => {
		bucketInfo.uniqueKey = result.uniqueKeys;
		bucketInfo.indexes = result.indexes;

		bucketInfo = {
			...bucketInfo,
			...convertTtlIndex(result.ttlIndex),
		};
	}, logError)
	.then(() => {
		cb(null, bucketInfo);
	}, err => {
		cb(err, bucketInfo);
	});

}

function getCollectionTTLInfo({ defaultTtl }) {
	switch (defaultTtl) {
		case undefined:
			return {
				TTL: 'Off'
			}
		case -1:
			return { TTL: 'On (no default)' };
		default:
			return {
				TTLseconds: defaultTtl,
				TTL: 'On'
			};
	}
}

function getCollectionTriggers(triggers = []) {
	return triggers.map(({ id, triggerType, triggerOperation, body }) => {
		return {
			triggerID: id,
			prePostTrigger: triggerType === 'Pre' ? 'Pre-Trigger' : 'Post-Trigger',
			triggerOperation,
			triggerFunction: body
		}
	});
}

function getCollectionUDFS(udfs = []) {
	return udfs.map(({ id, body }) => {
		return {
			udfID: id,
			udfFunction: body
		}
	});
}

function getCollectionStoredProcedures(sprocs = []) {
	return sprocs.map(({ id, body }) => {
		return {
			storedProcID: id,
			storedProcFunction: body
		}
	});
}

function getCollectionIndexes(indexingPolicy) {
	if (!indexingPolicy) {
		return [];
	}
	const { automatic, indexingMode } = indexingPolicy;
	const mapIndex = (index, includedPath, excludedPath) => {
		return {
			automatic: automatic ? 'true' : 'false',
			mode: indexingMode ? _.capitalize(indexingMode) : 'None',
			indexIncludedPath: includedPath,
			kind: index.kind,
			dataType: index.dataType,
			indexPrecision: index.precision,
			indexExcludedPath: excludedPath
		}
	}
	let collectionIndexes = [];
	
	_.get(indexingPolicy, 'includedPaths', []).forEach(({ path, indexes = [] }) => {
		const includedPathIndexes = indexes.map(index => mapIndex(index, path, ''));
		collectionIndexes = collectionIndexes.concat(includedPathIndexes);
	})

	_.get(indexingPolicy, 'excludedPaths', []).forEach(({ path, indexes = [] }) => {
		const excludedPathIndexes = indexes.map(index => mapIndex(index, '', path));
		collectionIndexes = collectionIndexes.concat(excludedPathIndexes);
	})

	return collectionIndexes;
}

function convertTtlIndex(ttlIndex) {
	let TTL = 'Off';

	if (!ttlIndex) {
		return { TTL };
	}

	if (ttlIndex.expireAfterSeconds === -1) {
		TTL = 'On (no default)';
	} else {
		TTL = 'On';
	}

	const TTLseconds = ttlIndex.expireAfterSeconds;

	return {
		TTL,
		TTLseconds,
	};
}
