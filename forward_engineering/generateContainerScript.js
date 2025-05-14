const _ = require('lodash');
const { getScript, insertSamples } = require('./helpers/scriptHelper');

const generateContainerScript = (data, logger, callback, app) => {
	try {
		const insertSamplesOption =
			_.get(data, 'options.additionalOptions', []).find(option => option.id === 'INCLUDE_SAMPLES') || {};
		const withSamples = data.options.origin !== 'ui';
		let script = getScript(data);
		const samples = insertSamples(data);
		script += withSamples ? '\n' + samples : '';

		if (withSamples || !insertSamplesOption.value) {
			return callback(null, script);
		}

		return callback(null, [
			{ title: 'MongoDB script', script },
			{
				title: 'Sample data',
				script: samples,
			},
		]);
	} catch (e) {
		const error = { message: e.message, stack: e.stack };
		logger.log('error', error, 'CosmosDB w\\ Mongo API forward engineering error');
		callback(error);
	}
};

module.exports = {
	generateContainerScript,
};
