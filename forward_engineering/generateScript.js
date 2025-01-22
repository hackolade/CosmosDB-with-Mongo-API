const { getScript, insertSample } = require('./helpers/scriptHelper');

const generateScript = (data, logger, callback, app) => {
	try {
		const script = getScript(data);
		const samples = insertSample({
			containerData: data.containerData,
			entityData: data.entityData,
			sample: data.jsonData,
		});

		return callback(null, [script, samples].join('\n\n'));
	} catch (e) {
		const error = { message: e.message, stack: e.stack };
		logger.log('error', error, 'CosmosDB w\\ Mongo API forward engineering error');
		callback(error);
	}
};

module.exports = {
	generateScript,
};
