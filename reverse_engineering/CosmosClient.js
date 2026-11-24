const crypto = require('crypto');
const { hckFetch } = require('@hackolade/fetch');

class CosmosClient {
	constructor(dbName, host, masterKey, isLocal) {
		this.host = isLocal ? `${host}:8081` : host;
		this.masterKey = masterKey;
		this.dbName = dbName;

		if (isLocal) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		}
	}

	getUDFS(collectionId) {
		const resourceType = 'udfs';

		return this.callApi(this.getResource(collectionId, resourceType)).then(({ UserDefinedFunctions }) => ({
			type: resourceType,
			data: UserDefinedFunctions,
		}));
	}

	getTriggers(collectionId) {
		const resourceType = 'triggers';

		return this.callApi(this.getResource(collectionId, resourceType)).then(({ Triggers }) => ({
			type: resourceType,
			data: Triggers,
		}));
	}

	getStoredProcs(collectionId) {
		const resourceType = 'sprocs';

		return this.callApi(this.getResource(collectionId, resourceType)).then(({ StoredProcedures }) => ({
			type: resourceType,
			data: StoredProcedures,
		}));
	}

	getCollection(collectionId) {
		const resourceType = 'colls';

		return this.callApi(this.getResource(collectionId, resourceType)).then(data => ({ type: resourceType, data }));
	}

	getCollectionWithExtra(collectionId, logger) {
		const dataHandlers = [this.getCollection, this.getUDFS, this.getTriggers, this.getStoredProcs];
		return Promise.all(
			dataHandlers.map(handler =>
				handler.call(this, collectionId).catch(err => {
					if (typeof logger === 'function') {
						logger(err);
					}
				}),
			),
		).then(res =>
			res.filter(Boolean).reduce((acc, { type, data }) => {
				acc[type] = data;
				return acc;
			}, {}),
		);
	}

	async callApi({ url, resourceType = '', resourceId = '' }, method = 'get') {
		const date = new Date().toUTCString();
		const response = await hckFetch(url, {
			method: method.toUpperCase(),
			headers: {
				'x-ms-version': '2017-02-22',
				'x-ms-date': date,
				'Content-Type': 'application/json',
				authorization: this.getAuthToken(method, resourceType, resourceId, date),
			},
		});

		if (response.status !== 200) {
			throw new Error(await response.text());
		}

		return response.json();
	}

	getAuthToken(verb = '', resourceType = '', resourceId = '', date) {
		const MasterToken = 'master';
		const TokenVersion = '1.0';
		const key = Buffer.from(this.masterKey, 'base64');
		const text = `${verb}\n${resourceType}\n${resourceId}\n${date.toLowerCase()}\n\n`;
		const body = Buffer.from(text, 'utf8');

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
			resourceType,
		};
	}

	async getAdditionalAccountInfo(connectionInfo) {
		const { clientId, appSecret, tenantId, subscriptionId, resourceGroupName, host } = connectionInfo;
		const accNameRegex = /(https:\/\/)?(.+)\.documents.+/i;
		const accountName = accNameRegex.test(host) ? accNameRegex.exec(host)[2] : '';
		const tokenBaseURl = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
		const urlParams = new URLSearchParams();
		urlParams.append('grant_type', 'client_credentials');
		urlParams.append('client_id', clientId);
		urlParams.append('client_secret', appSecret);
		urlParams.append('resource', 'https://management.azure.com/');

		const tokenResponse = await hckFetch(tokenBaseURl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: urlParams,
		});
		const tokenData = await parseJsonResponse(tokenResponse);
		const dbAccountBaseUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}?api-version=2015-04-08`;
		const accountResponse = await hckFetch(dbAccountBaseUrl, {
			headers: {
				'Authorization': `${tokenData.token_type} ${tokenData.access_token}`,
			},
		});
		let accountData = await parseJsonResponse(accountResponse);

		if (Array.isArray(accountData.value)) {
			accountData = accountData.value[0];
		}

		return {
			tenant: tenantId,
			resGrp: resourceGroupName,
			subscription: subscriptionId,
			preferredLocation: accountData.location,
			enableMultipleWriteLocations: accountData.properties.enableMultipleWriteLocations,
			enableAutomaticFailover: accountData.properties.enableAutomaticFailover,
			isVirtualNetworkFilterEnabled: accountData.properties.isVirtualNetworkFilterEnabled,
			virtualNetworkRules: accountData.properties.virtualNetworkRules.map(
				({ id, ignoreMissingVNetServiceEndpoint }) => ({
					virtualNetworkId: id,
					ignoreMissingVNetServiceEndpoint,
				}),
			),
			ipRangeFilter: accountData.properties.ipRangeFilter,
			tags: Object.entries(accountData.tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
			locations: accountData.properties.locations.map(
				({ id, locationName, failoverPriority, isZoneRedundant }) => ({
					locationId: id,
					locationName,
					failoverPriority,
					isZoneRedundant,
				}),
			),
		};
	}
}

async function parseJsonResponse(response) {
	if (response.status !== 200) {
		throw new Error(await response.text());
	}

	return response.json();
}

module.exports = CosmosClient;
