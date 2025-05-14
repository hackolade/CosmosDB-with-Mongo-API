const { generateScript } = require('./generateScript');
const { generateContainerScript } = require('./generateContainerScript');
const applyToInstanceHelper = require('./helpers/applyToInstanceHelper');

module.exports = {
	generateScript,

	generateContainerScript,

	applyToInstance: applyToInstanceHelper.applyToInstance,

	testConnection: applyToInstanceHelper.testConnection,
};
