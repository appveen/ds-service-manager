const mongoose = require('mongoose');
const systemGlobalSchema = require('../systemGlobalSchema.js');
const mongooseDataType = ['String', 'Number', 'Date', 'Boolean', 'Object', 'Array'];

var e = {};

function getGlobalDefinition(id, globalDefArr) {
	let obj = globalDefArr.find(obj => obj._id === id && obj.definition);
	if (!obj) return null;
	return obj.definition;
}

function getSystemGlobalDefinition(type, globalDefArr) {
	let obj = globalDefArr.find(obj => obj.name === type);
	if (!obj) return null;
	return obj.definition;
}

function getAllGlobalDefinitions(app) {
	let globalDocs = null;
	return new Promise(resolve => {
		mongoose.model('globalSchema').find({ 'app': app, definition: { $exists: true } }, 'name definition')
			.then(docs => {
				if (docs) {
					docs = JSON.parse(JSON.stringify(docs));
					docs = docs.map(doc => {
						// if (doc.definition) doc.definition = JSON.parse(doc.definition);
						return doc;
					});
					globalDocs = docs;
				}
				resolve(globalDocs);
			});
	});
}

function substituteGlobalDefinition(schema, globalSchema) {
	schema.forEach(attribute => {
		if (attribute.key !== 'properties' && attribute.key !== '_id') {
			if (attribute['type'] == 'Global' || (attribute['properties'] && attribute['properties']['schema'])) {
				if (!attribute['properties']['schema']) throw new Error('Property schema missing for type Global');
				let globalDefinition = getGlobalDefinition(attribute['properties']['schema'], globalSchema);
				globalDefinition.key = attribute.key;
				let properties = attribute['properties'];
				if (!globalDefinition) throw new Error('Library schema not found.');
				attribute = JSON.parse(JSON.stringify(globalDefinition));
				if (properties) attribute['properties'] = JSON.parse(JSON.stringify(properties));
			}
			else if (attribute['properties'] && attribute['properties']['relatedTo']) {
				let sysDef = getSystemGlobalDefinition('Relation', systemGlobalSchema);
				if (sysDef) {
					sysDef.key = attribute.key;
					let properties = attribute['properties'];
					attribute = JSON.parse(JSON.stringify(sysDef));
					if (properties) attribute['properties'] = JSON.parse(JSON.stringify(properties));
				}
			}
			else if (attribute['type'] == 'User') {
				let sysDef = getSystemGlobalDefinition('User', systemGlobalSchema);
				if (sysDef) {
					sysDef.key = attribute.key;
					let properties = attribute['properties'];
					attribute = JSON.parse(JSON.stringify(sysDef));
					if (properties) attribute['properties'] = JSON.parse(JSON.stringify(properties));
				}
			}
			else if (attribute['properties'] && attribute['properties']['password']) {
				let sysDef = getSystemGlobalDefinition('SecureText', systemGlobalSchema);
				if (sysDef) {
					sysDef.key = attribute.key;
					let properties = attribute['properties'];
					let newDef = JSON.parse(JSON.stringify(sysDef));
					if (attribute['properties']['unique']) {
						newDef.definition.checksum.properties.unique = true;
					}
					attribute = newDef;
					if (properties) attribute['properties'] = JSON.parse(JSON.stringify(properties));
				}
			}
			if (attribute['definition'])
				substituteGlobalDefinition(attribute['definition'], globalSchema);
		}
	});
}

function substituteSystemGlobalDefinition(schema) {
	schema.forEach(attribute => {
		if (attribute.key !== 'properties' && attribute.key !== '_id') {
			if (mongooseDataType.indexOf(attribute['type']) == -1) {
				let sysDef = getSystemGlobalDefinition(attribute['type'], systemGlobalSchema);
				if (sysDef) {
					sysDef.key = attribute.key;
					let properties = attribute['properties'];
					attribute = JSON.parse(JSON.stringify(sysDef));
					if (properties) attribute['properties'] = JSON.parse(JSON.stringify(properties));
				}
			}
			if (attribute['definition'])
				substituteSystemGlobalDefinition(attribute['definition'], systemGlobalSchema);
		}
	});
}

e.expandSchemaWithSystemGlobalDef = function (definition) {
	substituteSystemGlobalDefinition(definition);
	return definition;
};

e.expandSchemaWithGlobalDef = function (app, definition) {
	return new Promise((resolve, reject) => {
		getAllGlobalDefinitions(app)
			.then(globalDefinitions => {
				if (globalDefinitions) substituteGlobalDefinition(definition, globalDefinitions);
				resolve(definition);
			})
			.catch(err => {
				reject(err);
			});
	});
};

module.exports = e;