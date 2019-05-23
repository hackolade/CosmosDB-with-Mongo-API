const crypto = require('crypto');
const axios = require('axios');

class CosmoClient {
	constructor(dbName, host, masterKey) {
		this.host = host;
		this.masterKey = masterKey;
		this.dbName = dbName;
	}

	getUDFS(collectionId) {
		const resourceType = 'udfs';

		return this.callApi(this.getResource(collectionId, resourceType))
			.then(({ UserDefinedFunctions }) => ({ type: resourceType, data: UserDefinedFunctions }));
	}

	getTriggers(collectionId) {
		const resourceType = 'triggers';

		return this.callApi(this.getResource(collectionId, resourceType))
			.then(({ Triggers }) => ({ type: resourceType, data: Triggers }));
	}

	getStoredProcs(collectionId) {
		const resourceType = 'sprocs';

		return this.callApi(this.getResource(collectionId, resourceType))
			.then(({ StoredProcedures }) => ({ type: resourceType, data: StoredProcedures }));
	}

	getCollection(collectionId) {
		const resourceType = 'colls';

		return this.callApi(this.getResource(collectionId, resourceType))
			.then(data => ({ type: resourceType, data }));
	}

	getCollectionWithExtra(collectionId) {
		const dataHandlers = [this.getCollection, this.getUDFS, this.getTriggers, this.getStoredProcs];
		return Promise.all(dataHandlers.map((handler) => handler.call(this, collectionId)));
	}

	callApi({ url, resourceType = '', resourceId = ''}, method = 'get') {
		const date = new Date().toUTCString();
		return axios({
			method,
			url,
			headers: {
				'x-ms-version': '2017-02-22',
				'x-ms-date': date,
				'Content-Type': 'application/json',
				authorization: this.getAuthToken(method, resourceType, resourceId, date)
			}
		})
		.then(({ data }) => data);
	}

	getAuthToken(verb = '', resourceType = '', resourceId = '', date) {
		const MasterToken = 'master';
		const TokenVersion = '1.0';
		const key = new Buffer(this.masterKey, 'base64');
		const text = `${verb}\n${resourceType}\n${resourceId}\n${date.toLowerCase()}\n\n`;
		const body = new Buffer(text, 'utf8');

		const signature = crypto.createHmac('sha256', key).update(body).digest('base64');

		const authToken = encodeURIComponent(`type=${MasterToken}&ver=${TokenVersion}&sig=${signature}`);
		return authToken;
	}

	getRequestURL(resourceId, resourceType = '') {
		return `https://${this.host}/${resourceId}/${resourceType}`;
	}

	getResource(collectionId, resourceType) {
		const resourceId = `dbs/${this.dbName}/colls/${collectionId}`;

		let url = this.getRequestURL(resourceId, resourceType);
		if (resourceType === 'dbs' || resourceType === 'colls') {
			url = this.getRequestURL(resourceId);
		}

		return {
			url,
			resourceId,
			resourceType
		};
	}
};

module.exports = CosmoClient;