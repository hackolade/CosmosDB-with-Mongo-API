
const isObjectEmpty = obj => Object.keys(obj).length === 0;

const filterObject = obj => Object.fromEntries(Object.entries(obj).filter(([key, value]) => value !== undefined));

const createIndexStatement = (...args) => {
	return 'createIndex(' + args.map(filterObject).filter(arg => !isObjectEmpty(arg)).map(stringify).join(', ') + ');';
};

const stringify = (data) => JSON.stringify(data, null, 2);

const getIndexType = (indexType) => {
	return ({
		'descending': -1,
		'ascending': 1,
		'2dsphere': '2dsphere',
	})[indexType] || 1;
};

const createIndex = (index) => {
	const indexKeys = index?.indexKey;

	if (!Array.isArray(indexKeys) || indexKeys.length === 0) {
		return '';
	}

	return createIndexStatement(
		indexKeys.reduce((result, indexKey) => ({
			...result,
			[indexKey.name]: getIndexType(indexKey.type),
		}), {}),
		{
			name: index.name,
		}
	);
};

const createTtlIndex = (containerData = {}) => {
	if (containerData.TTL === 'Off' || !containerData.TTL) {
		return '';
	}

	return createIndexStatement({
		_ts: 1,
	}, filterObject({
		name: 'ttl',
		expireAfterSeconds: containerData.TTL === 'On (no default)'
			? -1
			: containerData.TTLseconds,
	}));
};

const createUniqueIndex = (uniqueKeys, shardKey) => {
	if (!Array.isArray(uniqueKeys) || uniqueKeys.length === 0) {
		return '';
	}

	return createIndexStatement(
		uniqueKeys.reduce((result, indexKey) => ({
			...result,
			[indexKey.name]: 1,
		}), shardKey ? {
			[shardKey]: 1,
		} : {}),
		{
			unique: true,
		}
	);
};

const getContainerName = (containerData) => {
	return containerData[0]?.code || containerData[0]?.name;
};

const getCollection = (name) => {
	return `db.getCollection("${name}")`;
};

const getIndexes = (containerData) => {
	const indexes = containerData[1]?.indexes || [];
	const uniqueIndexes = containerData[0]?.uniqueKey || [];
	const shardKey = containerData[0]?.shardKey?.[0]?.name;

	return [
		...uniqueIndexes.map(uniqueKey => createUniqueIndex(uniqueKey.attributePath, shardKey)),
		...indexes.map(createIndex),
		createTtlIndex(containerData[0]),
	].filter(Boolean).map(index => getCollection(getContainerName(containerData)) + '.' + index).join('\n\n');
};

const createShardKey = ({ modelData, containerData }) => {
	const shardKey = containerData[0]?.shardKey?.[0]?.name;

	if (!shardKey) {
		return '';
	}

	const dbId = getDbId(modelData);
	const name = getContainerName(containerData);

	return `use admin;\ndb.runCommand({ shardCollection: "${dbId}.${name}", key: { "${shardKey}": "hashed" }});`
};

const getDbId = (modelData) => {
	return modelData[0]?.dbId;
};

const getScript = (data) => {
	const name = getDbId(data.modelData);
	const useDb = name ? `use ${name};` : '';
	const indexes = getIndexes(data.containerData);

	return [createShardKey(data), useDb, indexes].filter(Boolean).join('\n\n');
};

const updateSample = (sample, containerData, entityData) => {
	const docType = containerData.docTypeName;

	if (!docType) {
		return sample;
	}

	return {
		...sample,
		[docType]: entityData.code || entityData.collectionName,
	};
};

const insertSample = ({ containerData, entityData, sample }) => {
	return getCollection(getContainerName(containerData)) + `.insert(${JSON.stringify(
		updateSample(sample, containerData[0], entityData?.[0] || {}),
		null,
		2,
	)});`;
};

const insertSamples = (data) => {
	const name = getDbId(data.modelData);
	const useDb = name ? `use ${name};` : '';
	const samples = data.entities.map(entityId => insertSample({
		containerData: data.containerData,
		entityData: (data.entityData[entityId] || []),
		sample: JSON.parse(data.jsonData[entityId]),
	})).join('\n\n');

	return [useDb, samples].filter(Boolean).join('\n\n');
};

module.exports = {
	getScript,
	insertSample,
	insertSamples,
};
