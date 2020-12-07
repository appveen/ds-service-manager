'use strict';

const mongoose = require('mongoose');
const definition = require('../helpers/serviceManager.definition.js').definition;
const draftDefinition = JSON.parse(JSON.stringify(definition));
const SMCrud = require('@appveen/swagger-mongoose-crud');
const cuti = require('@appveen/utils');
const request = require('request');
const smhelper = require('../helpers/util/smhelper');
const _ = require('lodash');
const smHooks = require('../helpers/serviceManagerHooks.js');
const globalDefHelper = require('../helpers/util/globalDefinitionHelper.js');
const envConfig = require('../../config/config.js');
const relationManager = require('../helpers/relationManager.js');
const deployUtil = require('../deploy/deploymentUtil');
const docker = require('../../util/docker.js');
const k8s = require('../../util/k8s.js');
const fileIO = require('../../util/codegen/lib/fileIO.js');
const odputils = require('@appveen/odp-utils'); //Common utils for Project
const kubeutil = require('@appveen/odp-utils').kubeutil;
const net = require('net');
let getCalendarDSDefinition = require('../helpers/calendar').getCalendarDSDefinition;
let queueMgmt = require('../../util/queueMgmt');
let rolesUtil = require('../helpers/roles');
//const fs = require('fs');
var client = queueMgmt.client;

const schemaValidate = require('../helpers/util/smhelper.js').schemaValidate;
const schemaValidateDefault = require('../helpers/util/smhelper.js').schemaValidateDefault;

const schema = new mongoose.Schema(definition, {
	usePushEach: true
});
const draftSchema = new mongoose.Schema(draftDefinition, {
	usePushEach: true
});

const logger = global.logger;
const destroyDeploymentRetry = 5;
const startPort = 20010;
const expandRelationHelper = require('../helpers/util/expandRelations');

var options = {
	logger: logger,
	collectionName: 'services'
};

var draftOptions = {
	logger: logger,
	collectionName: 'services.draft'
};

schema.pre('validate', function (next) {
	var self = this;
	self.name = self.name.trim();
	self.api ? self.api = self.api.trim() : `/${_.camelCase(self.name)}`;
	// if (self.definition) self.definition = self.definition.trim();
	if (self.name && _.isEmpty(self.name)) next(new Error('name is empty'));
	if (self.definition && _.isEmpty(self.definition)) next(new Error('definition is empty'));
	if (!_.isEmpty(self.preHooks)) {
		let preHookNames = _.uniq(self.preHooks.map(_d => _d.name));
		if (preHookNames.length != self.preHooks.length) {
			next(new Error('Prehooks contains duplicate name'));
		}
	}
	next();
});

draftSchema.pre('validate', function (next) {
	var self = this;
	self.name = self.name.trim();
	self.api = self.api.trim();
	// self.definition = self.definition.trim();
	if (_.isEmpty(self.name)) next(new Error('name is empty'));
	if (_.isEmpty(self.definition)) next(new Error('definition is empty'));
	if (!_.isEmpty(self.preHooks)) {
		let preHookNames = _.uniq(self.preHooks.map(_d => _d.name));
		if (preHookNames.length != self.preHooks.length) {
			next(new Error('Prehooks contains duplicate name'));
		}
	}
	next();
});

schema.index({ api: 1, app: 1 }, { unique: '__CUSTOM_API_DUPLICATE_ERROR__' });

schema.index({ name: 1, app: 1 }, { unique: '__CUSTOM_NAME_DUPLICATE_ERROR__' });

schema.post('save', function (error, doc, next) {
	if ((error.errors && error.errors.api) || error.name === 'ValidationError' && error.message.indexOf('__CUSTOM_API_DUPLICATE_ERROR__') > -1) {
		next(new Error('API endpoint is already in use'));
	} else {
		next(error);
	}
});

schema.post('save', function (error, doc, next) {
	if ((error.errors && error.errors.name) || error.name === 'ValidationError' && error.message.indexOf('__CUSTOM_NAME_DUPLICATE_ERROR__') > -1) {
		next(new Error('Entity name is already in use'));
	} else {
		next(error);
	}
});

draftSchema.pre('validate', function (next) {
	let self = this;
	return crudder.model.findOne({ app: self.app, api: self.api, _id: { $ne: self._id } }, { _id: 1 })
		.then(_d => {
			if (_d) {
				return next(new Error('API endpoint is already in use'));
			} else {
				return draftCrudder.model.findOne({ app: self.app, api: self.api, _id: { $ne: self._id } }, { _id: 1 })
					.then(_e => {
						if (_e) return next(new Error('API endpoint is already in use'));
						return next();
					});
			}
		})
		.catch(err => {
			logger.error(err);
			next(err);
		});
});

draftSchema.pre('validate', function (next) {
	let self = this;
	return crudder.model.findOne({ app: self.app, name: self.name, _id: { $ne: self._id } }, { _id: 1 })
		.then(_d => {
			if (_d) {
				return next(new Error('Entity name is already in use'));
			} else {
				return draftCrudder.model.findOne({ app: self.app, name: self.name, _id: { $ne: self._id } }, { _id: 1 })
					.then(_e => {
						if (_e) {
							return next(new Error('Entity name is already in use'));
						}
						return next();
					});
			}
		})
		.catch(err => {
			logger.error(err);
			next(err);
		});
});

schema.pre('validate', function (next) {
	let self = this;
	let app = self.app;
	let dsCalendarDetails = getCalendarDSDetails(app);
	if (self.isNew && self.type != 'internal') {
		if (self.name == dsCalendarDetails.name) return next(new Error('Cannot use this name.'));
		else if (self.api == dsCalendarDetails.api) return next(new Error('Cannot use this API'));
		else next();
	}
	next();
});

schema.pre('save', function (next) {
	let self = this;
	if (self._metadata.version) {
		self._metadata.version.release = process.env.RELEASE;
	}
	next();
});

draftSchema.pre('save', function (next) {
	let self = this;
	if (self._metadata.version) {
		self._metadata.version.release = process.env.RELEASE;
	}
	next();
});

schema.pre('save', function (next) {
	let self = this;
	try {
		if (self.definition) schemaValidate(self.definition);
		next();
	} catch (error) {
		next(error);
	}
});

draftSchema.pre('save', function (next) {
	let self = this;
	try {
		schemaValidate(self.definition);
		next();
	} catch (error) {
		next(error);
	}
});

function reserved(def) {
	var keywords = ['schema', 'collection', 'db', 'save', 'get', 'model', 'default'];
	var promise = def.map(ele => {
		if(ele.key && keywords.includes(ele.key.toLowerCase()))
			throw new Error(ele.key + ' cannot be used as an attribute name');
		if (ele.type == 'Object' || ele.type == 'Array')
			return reserved(ele.definition);
	});
	return Promise.all(promise);
	// var promise = Object.keys(def).map(function (key) {
	// 	for (var i = 0; i < keywords.length; i++) {
	// 		if (key.toLowerCase() == keywords[i]) {
	// 			throw new Error(keywords[i] + ` cannot be used as an attribute name`);
	// 		}
	// 	}
	// 	if (def[key].type == `Object` || def[key].type == `Array`) {
	// 		return reserved(def[key].definition);
	// 	}

	// });
	// return Promise.all(promise);
}
schema.pre('save', function (next) {
	let self = this;
	try {
		if (self.definition) reserved(self.definition);
		next();
	} catch (error) {
		next(error);
	}
});

draftSchema.pre('save', function (next) {
	let self = this;
	try {
		reserved(self.definition);
		next();
	} catch (error) {
		next(error);
	}
});

schema.pre('save', function (next) {
	let self = this;
	if (self.definition) {
		schemaValidateDefault(self.definition, self.app)
			.then(() => {
				next();
			})
			.catch(err => {
				next(err);
			});
	} else {
		next();
	}

});

draftSchema.pre('save', function (next) {
	let self = this;
	schemaValidateDefault(self.definition, self.app)
		.then(() => {
			next();
		})
		.catch(err => {
			next(err);
		});
});

function apiUniqueCheck(api, app, id) {
	let apiRegex = new RegExp('^' + api + '$', 'i');
	let filter = { 'app': app, 'api': apiRegex };
	if (id) filter._id = { '$ne': id };
	logger.debug('apiUniqueCheck filter ' + filter);
	return crudder.model.findOne(filter).lean(true)
		.then(_d => {
			if (_d) {
				return Promise.reject(new Error('API already in use'));
			} else {
				return draftCrudder.model.findOne(filter).lean(true)
					.then(_e => {
						if (_e) {
							return Promise.reject(new Error('API already in use with draft mode'));
						} else {
							return Promise.resolve();
						}
					});

			}
		});
}

function nameUniqueCheck(name, app, srvcId) {
	let nameRegex = new RegExp('^' + name + '$', 'i');
	let filter = { 'app': app, 'name': nameRegex };
	if (srvcId) filter._id = { '$ne': srvcId };
	return crudder.model.findOne(filter).lean(true)
		.then(_d => {
			if (_d) {
				return Promise.reject(new Error('Entity name already in use'));
			} else {
				return draftCrudder.model.findOne(filter).lean(true)
					.then(_e => {
						if (_e) {
							return Promise.reject(new Error('Entity name already in use'));
						} else {
							return Promise.resolve();
						}
					});
			}
		});
}

schema.pre('save', function (next) {
	if (this.name.length > 40) {
		next(new Error('Entity name must be less than 40 characters. '));
	} else {
		next();
	}
});

draftSchema.pre('save', function (next) {
	if (this.name.length > 40) {
		next(new Error('Entity name must be less than 40 characters. '));
	} else {
		next();
	}
});

schema.pre('save', function (next) {
	if (this.description && this.description.length > 250) {
		next(new Error('Entity description should not be more than 250 character '));
	} else {
		next();
	}
});

draftSchema.pre('save', function (next) {
	if (this.description && this.description.length > 250) {
		next(new Error('Entity description should not be more than 250 character '));
	} else {
		next();
	}
});

schema.pre('save', cuti.counter.getIdGenerator('SRVC', 'services', null, null, 2000));

schema.pre('save', function (next) {
	var apiregx = /^\/[a-zA-Z]+[a-zA-Z0-9]*$/;
	if (this.api.length > 40) {
		return next(new Error('API endpoint length cannot be greater than 40'));
	}
	if (this.api.match(apiregx)) {
		next();
	} else {
		next(new Error('API Endpoint must consist of alphanumeric characters and must start with \'/\' and followed by an alphabet.'));
	}
	next();
});

draftSchema.pre('save', function (next) {
	var apiregx = /^\/[a-zA-Z]+[a-zA-Z0-9]*$/;
	if (this.api.length > 40) {
		return next(new Error('API endpoint length cannot be greater than 40'));
	}
	if (this.api.match(apiregx)) {
		next();
	} else {
		next(new Error('API Endpoint must consist of alphanumeric characters and must start with \'/\' and followed by an alphabet.'));
	}
	next();
});

schema.pre('save', function (next) {
	if (envConfig.isCosmosDB()) {
		this.collectionName = this._id;
	} else {
		this.collectionName = this.api.substr(1);
	}
	next();
});

draftSchema.pre('save', function (next) {
	if (envConfig.isCosmosDB()) {
		this.collectionName = this._id;
	} else {
		this.collectionName = this.api.substr(1);
	}
	next();
});

function countAttr(def) {
	let count = 0;
	// if (def && typeof def === `object`) {
	// 	Object.keys(def).forEach(_d => {
	// 		if (def[_d] && def[_d].type === `Object`) {
	// 			count += countAttr(def[_d].definition);
	// 		} else {
	// 			count++;
	// 		}
	// 	});
	// 	return count;
	// } 
	if (def && typeof def === 'object') {
		def.forEach(_d => {
			if (_d && _d.type === 'Object') {
				count += countAttr(_d.definition);
			} else {
				count++;
			}
		});
		return count;
	} else {
		return count;
	}
}

schema.pre('save', function (next) {
	let self = this;
	if (!self.definition) next();
	// To check if _id ele need to be removed as +1 is there
	// let def = self.definition.filter(ele => ele.key != '_id');
	// let count = countAttr(def);
	// this.attributeCount = count + 1;
	this.attributeCount = countAttr(self.definition);
	next();
});

draftSchema.pre('save', function (next) {
	let self = this;
	// let def = JSON.parse(self.definition);
	// delete def._id;
	// let count = countAttr(def);
	// this.attributeCount = count + 1;

	// To check if _id ele need to be removed as =1 is there
	// let def = self.definition.filter(ele => ele.key != '_id');
	// let count = countAttr(def);
	// this.attributeCount = count + 1;
	this.attributeCount = countAttr(self.definition);
	next();
});

schema.pre('save', odputils.auditTrail.getAuditPreSaveHook('services'));

schema.post('save', odputils.auditTrail.getAuditPostSaveHook('sm.audit', client, 'auditQueue'));

schema.pre('remove', odputils.auditTrail.getAuditPreRemoveHook());

schema.post('remove', odputils.auditTrail.getAuditPostRemoveHook('sm.audit', client, 'auditQueue'));

var crudder = new SMCrud(schema, 'services', options);
var draftCrudder = new SMCrud(draftSchema, 'services.draft', draftOptions);

var e = {};

function getNextVal(_docs) {
	let nextPort = _docs[0].port + 1;
	for (var i = 1; i < _docs.length; i++) {
		if (nextPort !== _docs[i].port) break;
		else nextPort++;
	}
	return nextPort;
}

function getNextPort() {
	return mongoose.model('services').find({}, 'port', {
		sort: {
			port: 1
		}
	})
		.then((docs) => {
			if (docs && docs.length > 0) {
				return getNextVal(docs);
			} else {
				return startPort;
			}
		});
}

function checkIncomingRelation(serviceId) {
	return new Promise((resolve, reject) => {
		crudder.model.findOne({ _id: serviceId, '_metadata.deleted': false })
			.then((_doc) => {
				if (_doc) {
					_doc = _doc.toObject();
					if (_doc.relatedSchemas && _doc.relatedSchemas.incoming && !_.isEmpty(_doc.relatedSchemas.incoming)) {
						let extService = _doc.relatedSchemas.incoming.map(obj => obj.service);
						extService = _.uniq(extService);
						var c1 = extService.length;
						if (c1 === 1 && extService[0] === serviceId) {
							return resolve(_doc);
						}
						let rejectFlag = false;
						let relatedEntities = [];
						return crudder.model.find({ _id: { $in: extService } }, 'status name')
							.then(_docStatus => {
								_docStatus.forEach(docObj => {
									if (docObj.status != 'Undeployed' && docObj._id != serviceId) {
										rejectFlag = true;
										relatedEntities.push(docObj.name);
										// return;
									}
								});
								if (rejectFlag) reject({
									relatedEntities: relatedEntities,
									name: _doc.name
								});
								else resolve(_doc);
							});
					} else {
						return draftCrudder.model.find({ 'relatedSchemas.incoming.service': serviceId }, { name: 1 })
							.then(_d => {
								if (_d.length === 0) {
									resolve(_doc);
								} else {
									reject({
										relatedEntities: _d.map(_e => _e.name),
										name: _doc.name
									});
								}
							});
					}
				} else {
					resolve();
				}
			})
			.catch((err) => reject(err));
	});
}

function checkOutGoingRelation(serviceId) {
	return new Promise((resolve, reject) => {
		crudder.model.findOne({
			_id: serviceId,
			'_metadata.deleted': false
		})
			.then((_doc) => {
				if (_doc) {
					_doc = _doc.toObject();
					if (_doc.relatedSchemas.outgoing && !_.isEmpty(_doc.relatedSchemas.outgoing)) {
						let extService = _doc.relatedSchemas.outgoing.map(obj => obj.service);
						extService = _.uniq(extService);
						let rejectFlag = false;
						let relatedEntities = [];
						crudder.model.find({
							_id: {
								$in: extService
							}
						}, 'status name')
							.then(_docStatus => {
								_docStatus.forEach(docObj => {
									if (docObj.status == 'Undeployed') {
										rejectFlag = true;
										relatedEntities.push(docObj.name);
										// return;
									}
								});
								var c = extService.length;
								if (c == 1 && extService[0] == serviceId) {
									resolve(_doc);
								} else {
									if (rejectFlag) {
										reject({
											relatedEntities: relatedEntities,
											name: _doc.name
										});
									} else {
										resolve(_doc);
									}
								}
							});
					} else {
						resolve(_doc);
					}
				} else {
					resolve();
				}
			})
			.catch((err) => reject(err));
	});
}
//remove incoming relation of the entity 
function removeIncomingRelation(serviceId, req) {
	let promiseArr = [];
	return crudder.model.find({
		'relatedSchemas.incoming.service': serviceId
	}).then(docs => {
		docs.forEach(doc => {
			if (doc && !_.isEmpty(doc.relatedSchemas.incoming)) {
				doc.relatedSchemas.incoming = doc.relatedSchemas.incoming.filter(obj => obj.service != serviceId);
				doc.markModified('relatedSchemas.incoming');
				promiseArr.push(doc.save(req));
			}
		});
		return Promise.all(promiseArr);
	});
}

function createWebHooks(data, _req) {
	var options = {
		url: envConfig.baseUrlNE + '/webHook',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'TxnId': _req.get('txnId'),
			'Authorization': _req.get('Authorization')
		},
		json: true,
		body: data
	};
	request.post(options, function (err, res) {
		if (err) {
			logger.error(err.message);
		} else if (!res) logger.error('Notification Engine DOWN');
		else {
			logger.info('WebHook Added');
		}
	});
}
// To verify whether given webHook or preHook is exist or not
/*
e.verifyHook = (_req, _res) => {
	let url = _req.swagger.params.url && _req.swagger.params.url.value ? _req.swagger.params.url.value : null;
	if (!url) {
		return _res.status(400).json({ 'message': 'url invalid' });
	}
	let isVerified = false;
	var options = {
		url: url,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		json: true
	};
	if (typeof process.env.TLS_REJECT_UNAUTHORIZED === 'string' && process.env.TLS_REJECT_UNAUTHORIZED.toLowerCase() === 'false') {
		options.insecure = true;
		options.rejectUnauthorized = false;
	}
	request.post(options, function (err, res) {
		if (err) {
			logger.error(err.message);
		} else if (!res) {
			logger.error(url + ' ' + 'is down');
		}
		else if (res.statusCode === 404 || res.statusCode === 504 || res.statusCode === 405) {
			logger.info(url + ' ' + ' not exist');
		}
		else {
			logger.info(url + ' ' + 'exist');
			isVerified = true;
		}
		_res.status(200).json({ isVerified });
	});
};
*/
e.verifyHook = (_req, _res) => {
	let URL = require('url');
	let url = _req.swagger.params.url && _req.swagger.params.url.value ? _req.swagger.params.url.value : null;
	if (!url) {
		return _res.status(400).json({
			'message': 'url invalid'
		});
	}
	let urlObj = URL.parse(url);
	let client = new net.Socket();
	urlObj.port = urlObj.port ? urlObj.port : 80;
	if (urlObj.port < 0 || urlObj.port >= 65536) {
		return _res.status(400).end();
	}
	client.connect(urlObj.port, urlObj.hostname, function () {
		_res.status(200).end();
		client.destroy();
	});

	client.on('connect', function () {
		client.destroy();
	});

	client.on('error', function (data) {
		logger.debug('Received: ' + data);
		_res.status(400).end();
		client.destroy();
	});

	client.on('close', function () {
		if (!_res.headersSent) {
			_res.status(400).end();
		}
	});
	let timeout = (process.env.HOOK_CONNECTION_TIMEOUT && parseInt(process.env.HOOK_CONNECTION_TIMEOUT)) || 30;
	setTimeout(function () {
		client.destroy();
	}, timeout * 1000);
};

function removeWebHooks(serviceId, _req) {
	var options = {
		url: envConfig.baseUrlNE + '/webHook/' + serviceId,
		method: 'DELETE',
		headers: {
			'Content-Type': 'application/json',
			'TxnId': _req.get('txnId'),
			'Authorization': _req.get('Authorization')
		},
		json: true
	};
	request.delete(options, function (err, res) {
		if (err) {
			logger.error(err.message);
		} else if (!res) logger.error('Notification Engine DOWN');
		else {
			logger.info('WebHook Removed');
		}
	});
}

function updateWebHook(id, data, _req) {
	var options = {
		url: envConfig.baseUrlNE + '/webHook/' + id,
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'TxnId': _req.get('txnId'),
			'Authorization': _req.get('Authorization')
		},
		json: true,
		body: {
			hookUrls: data.webHooks,
			// workflowHookUrls: data.workflowHooks
			workflowHooks: data.workflowHooks
		}
	};
	logger.debug(options);
	new Promise((resolve, reject) => request.put(options, function (err, res) {
		if (err) {
			logger.error(err.message);
			reject();
		} else if (!res) {
			logger.error('Notification Engine DOWN');
			reject();
		} else {
			logger.info('WebHook Updated');
			resolve();
		}
	}));
}

e.createDoc = (_req, _res) => {
	try {
		let socket = _req.app.get('socket');
		if (_req.body.definition) {
			let idObject = _req.body.definition.find(def => def.key == '_id');
			idObject.counter = idObject && idObject.counter ? parseInt(idObject.counter, 10) : 0;
			idObject.padding = idObject && idObject.padding ? parseInt(idObject.padding, 10) : null;
			if (idObject.padding > 15) {
				return _res.status(400).json({
					'message': '_id length cannot be greater than 15'
				});
			}
			if (idObject.counter && idObject.padding && idObject.counter.toString().length > idObject.padding) {
				//padding(i.e. Length in UI ) must be greater than or equal to number of digits in counter (i.e. Start value in UI).
				return _res.status(400).json({
					'message': '_id counter is greater than length'
				});
			}
		}
		_req.body.version = 1;
		_req.body.api = _req.body.api ? _req.body.api.trim() : `/${_.camelCase(_req.body.name)}`;
		if (_req.body.api) {
			_req.body.api = _req.body.api.charAt(0) === '/' ? _req.body.api : '/' + _req.body.api;
		}
		let role = _req.body.role;
		delete _req.body.role;
		let serviceObj = null;
		return getNextPort()
			.then(port => _req.body.port = port)
			.then(() => smHooks.validateApp(_req))
			.then(() => apiUniqueCheck(_req.body.api, _req.body.app))
			.then(() => nameUniqueCheck(_req.body.name, _req.body.app))
			.then(() => {
				if (_req.body.definition) {
					return globalDefHelper.expandSchemaWithGlobalDef(_req.body.app, _req.body.definition);
				}
			})
			.then(expandedDef => {
				if (expandedDef) {
					_req.body.definition = expandedDef;
					return relationManager.checkRelationsAndCreate(_req.body, _req);
				} else {
					let model = mongoose.model('services');
					let doc = new model(_req.body);
					return doc.save(_req);
				}
			})
			.then(_d => {
				serviceObj = _d;
				// To check => if definition is string of array
				let permObj = {
					_id: serviceObj._id,
					app: serviceObj.app,
					entity: serviceObj._id,
					entityName: serviceObj.name,
					roles: role ? role.roles : null,
					type: 'appcenter',
					fields: role && role.fields ? JSON.stringify(role.fields) : null,
					definition: _req.body.definition ? _req.body.definition : null
				};
				return deployUtil.postRolesUserMgmt(permObj, _req);
			})
			.then(() => {
				if (serviceObj.definition) {
					return smHooks.updateServicesInGlobalSchema(serviceObj, _req);
				}
			})
			.then(() => deployUtil.createServiceInUserMgmt(serviceObj._id, _req, {
				app: serviceObj.app,
				name: serviceObj.name
			}))
			.then(() => {
				return smHooks.createDSinMON(serviceObj, _req);
			})
			.then(() => {
				let _d = serviceObj;
				odputils.eventsUtil.publishEvent('EVENT_DS_CREATE', 'dataService', _req, _d);
				_res.status(200).json(_d);
				deployUtil.sendToSocket(socket, 'newService', {
					_id: _d._id,
					app: _d.app,
					message: 'Entity has been created successfully.'
				});
				// deployUtil.deployService(_d, socket, _req, false, false);
				if (_d.webHooks && _d.workflowHooks && (_d.webHooks.length !== 0 || _d.workflowHooks.length !== 0)) {
					let data = {};
					data.service = _d._id;
					data.hookUrls = _d.webHooks;
					data.workflowHooks = _d.workflowHooks;
					data.entity = _d.name;
					createWebHooks(data, _req);
				}
			})
			.catch(_e => {
				logger.error(_e.message);
				if (serviceObj && serviceObj._id) {
					crudder.model.remove({
						_id: serviceObj._id
					})
						.then(_d => {
							logger.info('Removed service ' + _d._id + ' because of failure');
						});
				}
				if (!_res.headersSent) {
					_res.status(400).json({
						message: _e.message
					});
				}
				logger.error(_e);
			});
	} catch (e) {
		if (!_res.headersSent) {
			_res.status(400).json({
				message: e.message
			});
		}
		logger.error(e);
	}
};

/*
var oldJSON = {};
var newJSON = {};

function flattenJSON(_p, _d, _f) {
	for (var k in _d) {
		let path = (_p != '' ? _p + '.' : '') + k;
		if (typeof _d[k] == 'object') flattenJSON(path, _d[k], _f);
		else {
			if (_f) newJSON[path] = _d[k];
			else oldJSON[path] = _d[k];
		}
	}
}

function allowVersionChange(_o, _n) {
	for (var k in _o) {
		if (k.indexOf('required') == -1) {
			if (!_n.hasOwnProperty(k)) {
				logger.info('Change in schema detected');
				logger.info('path: ' + k, ', OLD Value : ' + _o[k], ', NEW Value : ' + _n[k]);
				return false;
			}
			if (_o[k] != _n[k]) {
				logger.info('Conflicting change in schema property');
				logger.info('path: ' + k, ', OLD Value : ' + _o[k], ', NEW Value : ' + _n[k]);
				return false;
			}
		}
	}
	return true;
}


function deepEqual(a, b) {
	if ((typeof a == "object" && a != null) && (typeof b == "object" && b != null)) {
		let count = [0, 0];
		for (let key in a) count[0]++;
		for (let key in b) count[1]++;
		if (count[0] - count[1] != 0) { return false; }
		for (let key in a)
			if (!(key in b) || !deepEqual(a[key], b[key])) return false;
		for (let key in b)
			if (!(key in a) || !deepEqual(b[key], a[key])) return false;
		return true;
	} else return a === b;
}
*/

function deepEqual(a, b) {
	return _.isEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

function validateCounterChange(isCounterChangeRequired, id, counter, app) {
	if (isCounterChangeRequired) {
		return getIdCounter(id, app)
			.then(_c => {
				if (_c) {
					if (counter <= _c) {
						throw new Error('id counter cannot be reduced');
					}
				}
				return Promise.resolve();
			});
	} else {
		return Promise.resolve();
	}
}

e.updateDoc = (_req, _res) => {
	logger.debug('Inside updateDoc');
	let ID = _req.swagger.params.id.value;
	delete _req.body.collectionName;
	delete _req.body.version;
	_req.body._id = ID;
	// replaceRelationWithString(_req.body.definition);
	logger.debug('Incoming data');
	logger.debug(JSON.stringify(_req.body));
	// let role = _req.body.role;
	// delete _req.body.role;
	let promise = Promise.resolve();
	if (_req.body.definition) {
		promise = globalDefHelper.expandSchemaWithGlobalDef(_req.body.app, _req.body.definition);
	}
	return promise
		.then(expandedDef => {
			if (expandedDef) _req.body.definition = expandedDef;
		})
		.then(() => crudder.model.findOne({ _id: ID, '_metadata.deleted': false }))
		.then(_d => {
			logger.debug('Data from DB.');
			logger.debug(JSON.stringify(_d));
			let oldData = JSON.parse(JSON.stringify(_d));
			if (!_d) {
				return _res.status(404).json({
					message: 'Not found'
				});
			}
			logger.debug('Old data found!');
			if (_req.body.app && _req.body.app !== oldData.app) {
				return _res.status(400).json({
					message: 'App change not permitted'
				});
			}

			let definitionComparison = true;
			if (!oldData.definition && _req.body.definition) definitionComparison = false;
			else if (oldData.definition && _req.body.definition) {
				definitionComparison = deepEqual(oldData.definition, _req.body.definition);
				if (!definitionComparison && oldData.type == 'internal' && !allowedChangeForCalendarDS(JSON.parse(JSON.stringify(oldData.definition)), JSON.parse(JSON.stringify(_req.body.definition)))) {
					logger.error('Changing definition is not allowed for calendar DS');
					return _res.status(400).json({
						message: 'Changing definition is not allowed for this DS.'
					});
				}
			}
			let isCounterChangeRequired = false;
			let oldIdElement = oldData.definition ? oldData.definition.find(d=> d.key == '_id') : {};
			let newIdElement = _req.body.definition ? _req.body.definition.find(d=> d.key == '_id') : {};
			let padding = newIdElement ? newIdElement.padding : null;
			if (!definitionComparison) {
				logger.debug('Definition has changed!');
				if ((padding != null) && padding > 15) {
					return _res.status(400).json({
						'message': '_id length cannot be greater than 15'
					});
				}
				if (oldIdElement && newIdElement && oldIdElement['padding'] > newIdElement['padding']) {
					_res.status(400).json({
						message: 'Decreasing _id\'s length in not allowed'
					});
					return;
				}
				if (oldIdElement && newIdElement && newIdElement['counter'] && oldIdElement['counter'] != newIdElement['counter']) {
					isCounterChangeRequired = true;
				}
			}

			let srvcObj = null;
			return smHooks.validateApp(_req)
				.then(() => {
					if (oldData.name != _req.body.name) {
						return nameUniqueCheck(_req.body.name, _req.body.app, ID);
					} else {
						return Promise.resolve();
					}
				})
				.then(() => {
					if (oldData.api && _req.body.api && oldData.api != _req.body.api) {
						return apiUniqueCheck(_req.body.api, _req.body.app, ID)
							.then(() => {
								return smhelper.canUpdateAPI(oldData.relatedSchemas.incoming);
							});
					} else {
						return Promise.resolve();
					}
				})
				.then(() => {
					if (_req.body.definition) return validateCounterChange(isCounterChangeRequired, ID, newIdElement['counter'], _req.body.app);
				})
				.then(() => {
					if (_d.status === 'Draft') {
						Object.assign(_d, _req.body);
						if (!definitionComparison) {
							logger.debug('Definition changed.');
							_d.definition = _req.body.definition;
						}
						return smHooks.updateServicesInGlobalSchema(_req.body, _req)
							.then(() => {
								if (oldData.definition) {
									return relationManager.checkRelationsAndUpdate(oldData, _d, _req);
								} else {
									return relationManager.getOutgoingRelationAndUpdate(_d, _req);
								}
							});
					} else if (_d.draftVersion) {
						return draftCrudder.model.findOne({ _id: ID, '_metadata.deleted': false })
							.then((newData) => {
								// _req.body.definition = JSON.stringify(_req.body.definition);
								newData = Object.assign(newData, _req.body);
								// _req.body.definition = JSON.parse(_req.body.definition);
								return relationManager.getOutgoingRelationAndUpdate(newData, _req);
							});
					} else {
						let model = draftCrudder.model;
						// _req.body.definition = JSON.stringify(_req.body.definition);
						let newData = new model(Object.assign({}, JSON.parse(JSON.stringify(oldData)), _req.body));
						//if (_req.body.definition) _req.body.definition = JSON.parse(_req.body.definition);
						newData.version = oldData.version + 1;
						_d.draftVersion = newData.version;
						logger.debug(JSON.stringify({ newData, _d }));
						return relationManager.getOutgoingRelationAndUpdate(newData, _req)
							.then(_n => _d.save(_req).then(() => _n));
					}
				})
				// .then(_data => {
				// 	srvcObj = _data;
				// 	let permObj = {
				// 		app: srvcObj.app,
				// 		entity: srvcObj._id,
				// 		entityName: srvcObj.name,
				// 		roles: role ? role.roles : null,
				// 		fields: role && role.fields ? JSON.stringify(role.fields) : null,
				// 		definition: _req.body.definition ? (typeof _req.body.definition == 'string' ? _req.body.definition : JSON.stringify(_req.body.definition)) : null
				// 	};
				// 	return deployUtil.updateRolesUserMgmt(srvcObj._id, permObj, _req);
				// })
				.then((_data) => {
					srvcObj = _data;
					_res.status(200).json(srvcObj);
				})
				.catch(err => {
					if (!_res.headersSent) _res.status(500).json({ message: err.message });
					logger.error(err);
				});
		})
		.catch(err => {
			logger.debug('Inside catch');
			if (!_res.headersSent)
				_res.status(400).json({
					message: err.message
				});
			logger.error(err);
		});
};

/**
 * Compares definitions for calendar DS and allows only limited change
 * 
 * @param {*} oldDefinition 
 * @param {*} newDefinition 
 */

function allowedChangeForCalendarDS(oldDefinition, newDefinition) {
	if(oldDefinition.length != newDefinition.length) return false;
	for(var i = 0; i < oldDefinition.length; i++) {
		if(newDefinition[i].key == 'name' && oldDefinition[i].key == 'name') {
			delete newDefinition[i].propperties.enum;
			delete oldDefinition[i].propperties.enum;
		}
		delete newDefinition[i].propperties.label;
		delete oldDefinition[i].propperties.label;
	}
	return _.isEqual(oldDefinition, newDefinition);
	// let isAllowed = true;
	// _.forEach(oldDefinition, function (oldAttr) {
	// 	newAttr = newDefinition.find(nAttr => nAttr.key === oldAttr.key);
	// 	if(!newAttr) {
	// 		isAllowed = false;
	// 		return false;
	// 	}
	// 	if(newAttr.key == 'name' && oldAttr.key == 'name') {
	// 		delete newAttr.propperties.enum;
	// 		delete oldAttr.propperties.enum;
	// 	}
	// 	delete newAttr.propperties.label;
	// 	delete oldAttr.propperties.label;
	// 	if(!_.isEqual(oldAttr, newAttr)) {
	// 		isAllowed = false;
	// 		return false;
	// 	}
	// });
	// return isAllowed;
	// let keysToIgnore = [`name.properties.enum`, `name.properties.label`, `holidayName.properties.label`, `date.properties.label`];
	// return _.isEqual(_.omit(oldDefinition, keysToIgnore), _.omit(newDefinition, keysToIgnore));
}

/**
 * Detects changes in data services and return events accordingly
 * 
 * @param {*} oldData 
 * @param {*} newData 
 */

function getAllEventsForDSUpdate(oldData, newData) {
	let eventsList = [];
	if (oldData.name != newData.name) eventsList.push('EVENT_DS_UPDATE_NAME');
	if (oldData.api != newData.api) eventsList.push('EVENT_DS_UPDATE_API');
	if (!deepEqual(oldData.versionValidity, newData.versionValidity)) eventsList.push('EVENT_DS_UPDATE_HISTORY');
	if (!deepEqual(oldData.webHooks, newData.webHooks)) eventsList.push('EVENT_DS_UPDATE_POSTHOOK');
	if (!deepEqual(oldData.preHooks, newData.preHooks)) eventsList.push('EVENT_DS_UPDATE_PREHOOK');
	if (!deepEqual(oldData.workflowHooks, newData.workflowHooks)) eventsList.push('EVENT_DS_UPDATE_WORKFLOWHOOK');
	if (!deepEqual(oldData.headers, newData.headers)) eventsList.push('EVENT_DS_UPDATE_HEADERS');
	if (oldData.role && newData.role && !deepEqual(oldData.role.roles, newData.role.roles)) eventsList.push('EVENT_DS_UPDATE_ROLE');
	if (oldData.enableSearchIndex != newData.enableSearchIndex) eventsList.push('EVENT_DS_UPDATE_FUZZYSEARCH');
	oldData.wizard.forEach(wz => delete wz._id);
	let newWizard = JSON.parse(JSON.stringify(newData.wizard));
	newWizard.forEach(wz => delete wz._id);
	if (!deepEqual(oldData.wizard, newWizard)) eventsList.push('EVENT_DS_UPDATE_EXPERIENCE');
	if ((!oldData.definition && newData.definition) ||
		(oldData.definition && newData.definition && !deepEqual(oldData.definition, newData.definition)))
		eventsList.push('EVENT_DS_UPDATE_DEFINITION');
	return eventsList;
}

function rollBackDeploy(id, req) {
	return draftCrudder.model.findOne({ _id: id })
		.then(_d => {
			if (_d) {
				return crudder.model.findOne({ _id: id });
			}
		})
		.then(_d => {
			if (_d) {
				_d.draftVersion = _d.version + 1;
				return _d.save(req);
			}
		})
		.catch(err => {
			logger.error(err);
		});
}

e.deployAPIHandler = (_req, _res) => {
	logger.debug('Inside deployAPIHandler');
	let socket = _req.app.get('socket');
	let isReDeploymentRequired = false;
	let preHookUpdated = false;
	let isWebHookUpdateRequired = false;
	let isWizardUpdateRequired = false;
	let isDeleteAndCreateRequired = false;
	let isAuditIndexDeleteRequired = false;
	let isApiEndpointChanged = false;
	let ID = _req.swagger.params.id.value;
	return crudder.model.findOne({ _id: ID, '_metadata.deleted': false })
		.then(_d => {
			logger.debug('Data from DB.');
			logger.debug(_d);
			let oldData = JSON.parse(JSON.stringify(_d));
			if (!_d) _res.status(404).json({ message: 'Not found' });
			else {
				logger.debug('Old data found!');
				if (_d.status != 'Draft' && !_d.draftVersion) {
					throw new Error('Draft not available for this data service');
				}
				if (_d.status === 'Draft') {
					let svcObject = _d.toObject();
					if (!svcObject.definition) throw new Error('Data service definition not found.');
					if (!svcObject.versionValidity) throw new Error('Data settings are not configured for the data service.');
					// svcObject.definition = JSON.parse(svcObject.definition);
					let promise = Promise.resolve();
					let role = svcObject.role;
					if (role) {
						let permObj = {
							app: svcObject.app,
							entity: svcObject._id,
							entityName: svcObject.name,
							roles: role ? role.roles : null,
							fields: role && role.fields ? JSON.stringify(role.fields) : null,
							// to check => converted to array
							definition: svcObject.definition
						};
						promise = deployUtil.updateRolesUserMgmt(svcObject._id, permObj, _req);
					}
					return promise
						.then(() => relationManager.checkRelationsAndUpdate(oldData, _d, _req))
						.then(() => {
							let newHooks = {
								'webHooks': svcObject.webHooks,
								'workflowHooks': svcObject.workflowHooks
							};
							return updateWebHook(ID, newHooks, _req);
						})
						.then(() => deployUtil.deployService(svcObject, socket, _req, false, false))
						.then(() => {
							odputils.eventsUtil.publishEvent('EVENT_DS_DEPLOYMENT_QUEUED', 'dataService', _req, _d);
							_res.status(202).json({ message: 'Deployment process started' });
						});
				} else {
					return draftCrudder.model.findOne({ _id: ID, '_metadata.deleted': false })
						.then(_newData => {
							if (_newData.webHooks || _newData.workflowHooks) isWebHookUpdateRequired = true;
							if (oldData.api != _newData.api) {
								isApiEndpointChanged = true;
								isDeleteAndCreateRequired = true;
								isReDeploymentRequired = true;
							}
							if (oldData.enableSearchIndex != _newData.enableSearchIndex) {
								isReDeploymentRequired = true;
							}
							if (_newData.app && _newData.app !== oldData.app) {
								return _res.status(400).json({
									message: 'App change not permitted'
								});
							}
							if (oldData.name != _newData.name) isReDeploymentRequired = true;
							if (oldData.disableInsights != _newData.disableInsights) isReDeploymentRequired = true;
							if(oldData.permanentDeleteData != _newData.permanentDeleteData) isReDeploymentRequired = true;
							logger.debug('oldWizard ' + JSON.stringify(oldData.wizard));
							logger.debug('newWizard ' + JSON.stringify(_newData.wizard));
							if (!_.isEqual(JSON.parse(JSON.stringify(oldData.wizard)), JSON.parse(JSON.stringify(_newData.wizard)))) isWizardUpdateRequired = true;
							if (oldData.versionValidity.validityType != _newData.versionValidity.validityType && _newData.versionValidity) {
								isReDeploymentRequired = true;
								isAuditIndexDeleteRequired = true;
							}
							if (!_.isEqual(JSON.parse(JSON.stringify(oldData.preHooks)), _newData.preHooks) || (_newData.experienceHooks && !_.isEqual(JSON.parse(JSON.stringify(oldData.experienceHooks)), _newData.experienceHooks))) {
								logger.info('Pre-hooks OR Experience-hooks changed');
								preHookUpdated = true;
							}
							if (oldData.versionValidity.validityValue != _newData.versionValidity.validityValue && _newData.versionValidity) {
								isReDeploymentRequired = true;
								isAuditIndexDeleteRequired = true;
							}
							let newDefinition = _newData.definition;
							let definitionComparison = deepEqual(oldData.definition, _newData.definition);
							let oldIdElement = oldData.definition ? oldData.definition.find(d=> d.key == '_id') : {};
							let newIdElement = _newData.definition ? _req.body.definition.find(d=> d.key == '_id') : {};
							let isCounterChangeRequired = false;
							let padding = newIdElement ? newIdElement.padding : null;
							if (!definitionComparison) {
								logger.debug('Definition has changed!');
								if (padding > 15) {
									return _res.status(400).json({
										'message': '_id length cannot be greater than 15'
									});
								}
								if (oldIdElement['padding'] > newIdElement['padding']) {
									_res.status(400).json({
										message: 'Decreasing _id\'s length in not allowed'
									});
									return;
								}
								if (newIdElement['counter'] && oldIdElement['counter'] != newIdElement['counter']) {
									isCounterChangeRequired = true;
								}
								isReDeploymentRequired = true;
							}
							if (isReDeploymentRequired || preHookUpdated || isWizardUpdateRequired) _newData.version = _d.version + 1;

							logger.debug('Webhook save required ' + isWebHookUpdateRequired);
							logger.debug('Redeployment required ' + isReDeploymentRequired);
							logger.debug('DeleteAndCreate required ' + isDeleteAndCreateRequired);
							logger.debug('AuditIndexDelete required ' + isAuditIndexDeleteRequired);

							let srvcObj = JSON.parse(JSON.stringify(_newData.toObject()));
							delete srvcObj.__v;
							Object.assign(_d, srvcObj);
							_d.draftVersion = null;
							if (!definitionComparison) _d.definition = newDefinition;
							let promise = Promise.resolve();

							if (oldData.name != _newData.name) {
								promise = nameUniqueCheck(_newData.name, _newData.app, ID);
							}
							return promise
								.then(() => {
									if (isApiEndpointChanged) {
										return apiUniqueCheck(_newData.api, _newData.app, ID);
									} else {
										return Promise.resolve();
									}
								})
								.then(() => {
									if (newDefinition) return validateCounterChange(isCounterChangeRequired, ID, newIdElement['counter'], _newData.app);
									else {
										return Promise.resolve();
									}
								})
								.then(() => relationManager.checkRelationsAndUpdate(oldData, _d, _req))
								.then(() => {
									// srvcObj = _data;
									let role = _d.role;
									if (!role) return Promise.resolve();
									let permObj = {
										app: srvcObj.app,
										entity: srvcObj._id,
										entityName: srvcObj.name,
										roles: role ? role.roles : null,
										fields: role && role.fields ? JSON.stringify(role.fields) : null,
										// to check => converted to array
										definition: newDefinition
									};
									return deployUtil.updateRolesUserMgmt(srvcObj._id, permObj, _req);
								})
								.then(() => {
									if (!definitionComparison) {
										return deployUtil.updateInPM(srvcObj._id, _req);
									}
								})
								.then(() => {
									return _newData.remove(_req);
								})
								.then(() => {
									odputils.eventsUtil.publishEvent('EVENT_DS_DEPLOYMENT_QUEUED', 'dataService', _req, _d);
									_res.status(202).json({ message: 'Deployment process started' });
									if (!envConfig.isCosmosDB() && srvcObj.collectionName != oldData.collectionName) {
										isReDeploymentRequired = true;
										return renameCollections(oldData.collectionName, srvcObj.collectionName, `${process.env.DATA_STACK_NAMESPACE}-${srvcObj.app}`);
									}
								})
								.then(() => smHooks.updateServicesInGlobalSchema(srvcObj, _req))
								.then(() => {
									return smHooks.updateExpiry(srvcObj, _req, oldData.collectionName, srvcObj.collectionName);
								})
								.then(() => logger.info('Service details for ' + _d._id + ' under app ' + _d.app + ' has been saved!'))
								.then(() => {
									if (isCounterChangeRequired) {
										return global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${srvcObj.app}`).collection('counters')
											.update({ _id: oldData.collectionName }, { next: parseInt(newIdElement['counter'], 10) - 1 });
									}
								})
								.then(_e => {
									if (_e) logger.info('counter for ' + oldData._id + ' updated successfully');
									let newHooks = {
										'webHooks': _newData.webHooks,
										'workflowHooks': _newData.workflowHooks
									};
									if (isWebHookUpdateRequired) return updateWebHook(ID, newHooks, _req);
								})
								// .then(() => {
								// 	if (isAuditIndexDeleteRequired) {
								// 		return global.mongoDBVishnu.collection(oldData.collectionName + '.audit').dropIndex('expiry_1')
								// 			.catch(err => {
								// 				logger.error(err.message);
								// 			});
								// 	}
								// 	return Promise.resolve();
								// })
								.then(() => {
									if (isApiEndpointChanged && srvcObj.relatedSchemas && srvcObj.relatedSchemas.incoming) {
										return expandRelationHelper.updateHrefInDS(ID, srvcObj.app, srvcObj.api, srvcObj.relatedSchemas.incoming, _req);
									}
								})
								.then(() => {
									logger.debug({
										isReDeploymentRequired,
										preHookUpdated,
										isWizardUpdateRequired
									});
									if (isReDeploymentRequired || preHookUpdated || isWizardUpdateRequired) {
										logger.debug(JSON.stringify(_d));
										logger.info('Redeploying service ' + _d._id + ' under app ' + _d.app);
										var data = JSON.parse(JSON.stringify(_d));
										// data.definition = JSON.parse(_d.definition);
										let mongoDBVishnu = global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${srvcObj.app}`);
										if (envConfig.isCosmosDB()) {
											return deployUtil.deployService(data, socket, _req, true, isDeleteAndCreateRequired ? oldData : false);
										} else {
											logger.info(`Reindexing the collection :: ${data.collectionName}`);
											return mongoDBVishnu.collection(data.collectionName).dropIndexes()
												.catch(err => {
													logger.error(err);
													return Promise.resolve(err);
												})
												.then(_d => {
													logger.debug(`Result of reindexing: ${_d}`);
													return deployUtil.deployService(data, socket, _req, true, isDeleteAndCreateRequired ? oldData : false);
												})
												.then(_d => {
													logger.debug('Deploy service returned');
													logger.debug(_d);
												});
										}
									}
								})
								.then(() => {
									let eventsList = getAllEventsForDSUpdate(oldData, _newData);
									eventsList.forEach(event => odputils.eventsUtil.publishEvent(event, 'dataService', _req, _newData));
								})
								.catch(err => {
									logger.debug('Inside catch');
									if (!_res.headersSent)
										_res.status(400).json({
											message: err.message
										});
									logger.error(err);
									return rollBackDeploy(ID, _req);
								});
						})
						.catch(err => {
							logger.debug('Inside catch');
							if (!_res.headersSent)
								_res.status(400).json({
									message: err.message
								});
							logger.error(err);
							return rollBackDeploy(ID, _req);
						});
				}
			}
		})
		.catch(err => {
			logger.debug('Inside catch');
			if (!_res.headersSent)
				_res.status(400).json({
					message: err.message
				});
			logger.error(err);
		});
};

e.startAPIHandler = (_req, _res) => {
	var id = _req.swagger.params.id.value;
	let socket = _req.app.get('socket');
	crudder.model.findOne({
		_id: id,
		'_metadata.deleted': false,
		'type': { '$nin': ['internal'] }
	})
		.then(doc => {
			if (doc) {
				checkOutGoingRelation(id)
					.then(() => {
						_res.status(202).json({
							message: 'Entity has been saved successfully'
						});
						// doc.save(_req);
						doc = doc.toObject();
						// doc.definition = JSON.parse(doc.definition);
						const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
						if (process.env.SM_ENV == 'K8s') {
							let instances = doc.instances ? doc.instances : 1;
							logger.info('Scaling to ' + instances);
							return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), instances)
								.then(_d => {
									logger.debug(_d);
									if (_d.statusCode == 404) {
										return k8s.serviceStart(doc)
											.then(() => deployUtil.deployService(doc, socket, _req, false, false))
											.then(() => odputils.eventsUtil.publishEvent('EVENT_DS_START', 'dataService', _req, doc));
									}
								})
								.catch(err => {
									logger.error(err);
								});
						}
						return deployUtil.deployService(doc, socket, _req, false, false)
							.then(() => odputils.eventsUtil.publishEvent('EVENT_DS_START', 'dataService', _req, doc));
					}, (data) => {
						let serviceMsg = '';
						if (data.relatedEntities.length == 1) {
							serviceMsg = 'Data Service: ' + data.relatedEntities[0];
						} else if (data.relatedEntities.length == 2) {
							serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ' & ' + data.relatedEntities[1];
						} else {
							serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ',' + data.relatedEntities[1] + ' & ' + 'more';
						}

						_res.status(400).json({
							message: 'Data Service ' + data.name + '  is dependent on the following ' + serviceMsg + '. Please make sure the dependent Data Services are also started.'
						});
					});

			} else {
				throw new Error('No service found with given id');
			}
		})
		.catch(e => {
			logger.error(e.message);
			if (!_res.headersSent) _res.status(500).json({
				message: e.message
			});
		});
};

e.stopAPIHandler = (_req, _res) => {
	let id = _req.swagger.params.id.value;
	let socket = _req.app.get('socket');
	let instances = null;
	checkIncomingRelation(id)
		.then(() => {
			_res.status(202).json({
				message: 'Deployment termination request accepted!'
			});
		}, (data) => {
			let serviceMsg = '';
			if (data.relatedEntities.length == 1) {
				serviceMsg = 'Data Service: ' + data.relatedEntities[0];
			} else if (data.relatedEntities.length == 2) {
				serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ' & ' + data.relatedEntities[1];
			} else {
				serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ',' + data.relatedEntities[1] + ' & ' + 'more';
			}

			_res.status(400).json({
				message: 'Data Service ' + data.name + ' cannot be stopped as it is being used by the following ' + serviceMsg + '. Try again after stopping/delinking from the related Data Services.'
			});
			throw new Error('Data Service ' + data.name + ' cannot be stopped as it is being used by the following ' + serviceMsg + '. Try again after stopping/delinking from the related Data Services.');
		})
		.then(() => {
			if (process.env.SM_ENV == 'K8s') {
				logger.info('Scaling down to 0');
				return crudder.model.findOne({
					_id: id,
					'type': { '$nin': ['internal'] }
				})
					.then(_d => {
						if (!_d) throw new Error('No service found with given id');
						const ns = envConfig.dataStackNS + '-' + _d.app.toLowerCase().replace(/ /g, '');
						return kubeutil.deployment.scaleDeployment(ns, _d.api.split('/')[1].toLowerCase(), 0);
					})
					.then(_d => {
						instances = _d && _d.status && _d.status.replicas ? _d.status.replicas : null;
						logger.info('Instances at time of undeploying ' + instances);
						if (instances) {
							return crudder.model.findOne({
								_id: id
							});
						}
					})
					.then(_d => {
						if (_d && instances) {
							_d.instances = instances;
							return _d.save(_req);
						}
					})
					.catch(err => {
						logger.error(err);
					});
			}
			return destroyDeployment(id, 0, _req);
		})
		.then(() => {
			return deployUtil.updateDocument(crudder.model, {
				_id: id
			}, {
				status: 'Undeployed'
			}, _req);
		})
		.then((doc) => {
			odputils.eventsUtil.publishEvent('EVENT_DS_STOP', 'dataService', _req, doc);
			deployUtil.sendToSocket(socket, 'serviceStatus', {
				_id: id,
				app: doc.app,
				message: 'Undeployed'
			});
		})
		.catch(err => {
			logger.error(err);
			if (!_res.headersSent)
				_res.status(500).send(err.message);
		});
};

function destroyServiceFolder(_id) {
	return fileIO.deleteFolderRecursive('./generatedServices/' + _id);
}


function destroyDeployment(id, count, _req) {
	logger.info('Destroy Attempt ' + count);
	let doc = null;
	return deployUtil.updateDocument(crudder.model, {
		_id: id
	}, {
		status: 'Pending'
	}, _req)
		.then(_d => {
			doc = _d;
			if (process.env.SM_ENV == 'K8s') {
				return k8s.deploymentDelete(_d)
					.then(() => logger.info('Deployment deleted for ' + _d._id))
					.then(() => k8s.serviceDelete(_d))
					.then(() => logger.info('Service deleted for ' + _d._id))
					.catch(_e => logger.error(_e));
			} else if (process.env.SM_ENV == 'Docker') {
				logger.info('Cleaning the docker containers...');
				return docker.stopService(_d._id)
					.then(() => logger.debug('Stopped the service'))
					.then(() => docker.removeService(_d._id))
					.then(() => logger.debug('Removed the service'))
					.then(() => logger.info('Docker service stopped :: ' + _d._id))
					.catch(_e => logger.error(_e));
			} else {
				logger.info('PM2 not supported');
			}
		})
		.then(() => destroyServiceFolder(id))
		.then(() => doc)
		.catch(err => {
			deployUtil.updateDocument(crudder.model, {
				_id: id
			}, {
				comment: err.message
			}, _req)
				.then(() => {
					if (count >= destroyDeploymentRetry)
						throw err;
				})
				.then(() => {
					return destroyDeployment(id, count + 1, _req);
				})
				.catch(e => logger.error(e.message));
		});
}

function renameCollections(oldColl, newColl, app) {
	let mongoDBVishnu = global.mongoConnection.db(app);
	if (mongoDBVishnu) {
		return mongoDBVishnu.collection(oldColl).rename(newColl)
			.then(out => {
				logger.info('Collection name changed from ' + oldColl + ' to ' + newColl);
				logger.debug(out);
				return mongoDBVishnu.collection('counters').findOne({
					_id: oldColl
				});
			})
			.then(_d => {
				if (_d) {
					let newObj = JSON.parse(JSON.stringify(_d));
					newObj._id = newColl;
					return mongoDBVishnu.collection('counters').insert(newObj);
				}
			})
			.then(_o => {
				if (_o) {
					logger.info('Added counter for ' + newColl);
					return mongoDBVishnu.collection('counters').remove({
						_id: oldColl
					});
				}
			})
			.then(_o => {
				if (_o) {
					logger.info('Removed counter for ' + oldColl);
				}
				return mongoDBVishnu.collection(oldColl + '.files').rename(newColl + '.files');
			})
			.then(out => {
				logger.info('Collection name changed from ' + oldColl + '.files' + ' to ' + newColl + '.files');
				logger.debug(out);
				return mongoDBVishnu.collection(oldColl + '.chunks').rename(newColl + '.chunks');
			})
			.then(out => {
				logger.info('Collection name changed from ' + oldColl + '.chunks' + ' to ' + newColl + '.chunks');
				logger.debug(out);
			})
			.catch(err => {
				logger.error(err.message);
			});
	}
}

function dropCollections(collectionName, app) {
	let mongoDBVishnu = global.mongoConnection.db(app);
	if (mongoDBVishnu) {
		mongoDBVishnu.dropCollection(collectionName, (err, coll) => {
			if (err) {
				logger.error(err.message);
			} else {
				if (coll) logger.info('Collection ' + collectionName + ' deleted successfully');
			}
		});
		let sufix = ['.bulkCreate', '.exportedFile.chunks', '.exportedFile.files', '.fileImport.chunks', '.fileImport.files', '.fileTransfers', '.files', '.chunks'];
		sufix.forEach(_s => {
			let colName = collectionName + _s;
			mongoDBVishnu.dropCollection(colName, (err, coll) => {
				if (err) logger.error(err);
				if (coll) logger.info('Collection ' + colName + ' deleted successfully');
			});
		});
		// mongoDBVishnu.dropCollection(collectionName + '.files', (err, coll) => {
		// 	if (coll) logger.info('Collection ' + collectionName + '.files deleted successfully');
		// });
		// mongoDBVishnu.dropCollection(collectionName + '.chunks', (err, coll) => {
		// 	if (coll) logger.info('Collection ' + collectionName + '.chunks deleted successfully');
		// });
		mongoDBVishnu.collection('counters').remove({
			_id: collectionName
		}, function (err) {
			if (err) logger.error(err.message);
			else {
				logger.info('counter ' + collectionName + ' deleted successfully');
			}
		});
	}
}

e.destroyService = (_req, _res) => {
	let id = _req.swagger.params.id.value;
	let socket = _req.app.get('socket');
	let originalDoc = {};
	logger.debug('Deleting the service ... ');
	return smhelper.getFlows(id, _req)
		.then(_flows => {
			logger.debug({ _flows });
			if (_flows.length > 0) {
				_res.status(400).json({ message: 'Data service is in use by flow ' + _flows.map(_f => _f.name) });
				throw new Error('Data service in use by flows');
			} else {
				return checkIncomingRelation(id);
			}
		})
		.then((doc) => {
			if (doc && doc.type != 'internal') {
				originalDoc = JSON.parse(JSON.stringify(doc));
				logger.debug(originalDoc);
				crudder.model.findOneAndUpdate({ _id: originalDoc._id }, { status: 'Pending' })
					.then(() => {
						_res.status(202).json({
							message: 'Undeploying data service ...'
						});
					})
					.catch(err => {
						_res.status(500).json({
							message: err.message
						});
					});
			} else if (doc && doc.type == 'internal') {
				_res.status(400).json({
					message: 'Can not delete this Service'
				});
				throw new Error('Can not delete this Service');
			} else {
				_res.status(404).json({
					message: 'Service not found'
				});
				throw new Error('Service not found');
			}
		}, (data) => {
			let serviceMsg = '';
			if (data.relatedEntities.length == 1) {
				serviceMsg = 'Data Service: ' + data.relatedEntities[0];
			} else if (data.relatedEntities.length == 2) {
				serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ' & ' + data.relatedEntities[1];
			} else {
				serviceMsg = 'Data Services: ' + data.relatedEntities[0] + ',' + data.relatedEntities[1] + ' & ' + 'more';
			}
			_res.status(400).json({
				message: 'Data Service ' + data.name + ' cannot be stopped as it is being used by the following ' + serviceMsg + '. Try again after stopping/delinking from the related Data Services.'
			});
			throw new Error('____CUSTOM_ENTITY_STOP_MSG_____');
		})
		.then(() => {
			if (originalDoc.status != 'Draft')
				return destroyDeployment(id, 0, _req);
		})
		.then(() => {
			deployUtil.sendToSocket(socket, 'serviceStatus', {
				_id: id,
				app: originalDoc.app,
				message: 'Entity has been stopped.'
			});
			deployUtil.deleteServiceInUserMgmt(id, _req);
			deployUtil.deleteServiceInWorkflow(id, _req);
			return removeIncomingRelation(id, _req);
		})
		.then(() => {
			if (process.env.SM_ENV == 'K8s' && originalDoc.status != 'Draft') {
				return k8s.deploymentDelete(originalDoc)
					.then(() => logger.info('Deployment deleted for ' + originalDoc._id))
					.then(() => k8s.serviceDelete(originalDoc))
					.then(() => logger.info('Service deleted for ' + originalDoc._id))
					.then(() => docker.removeImage(originalDoc._id, originalDoc.version))
					.catch(_e => logger.error(_e));
			} else if (process.env.SM_ENV == 'Docker' && originalDoc.status != 'Draft') {
				logger.info('Cleaning the docker images and containers...');
				return docker.stopService(originalDoc._id)
					.then(() => logger.debug('Stopped the service'))
					.then(() => docker.removeService(originalDoc._id))
					.then(() => logger.debug('Removed the service'))
					.then(() => docker.removeImage(originalDoc._id, originalDoc.version))
					.catch(_e => logger.error(_e));
			}
		})
		.then(() => smHooks.removeServicesInGlobalSchema(id, _req))
		.then(() => {
			if (originalDoc && originalDoc.permanentDeleteData) {
				dropCollections(originalDoc.collectionName, `${process.env.DATA_STACK_NAMESPACE}-${originalDoc.app}`);
			}
		})
		.then(() => {
			crudder.model.findOne({
				_id: id,
				'_metadata.deleted': false
			})
				.then((doc) => {
					if (doc) {
						deployUtil.sendToSocket(socket, 'deleteService', {
							_id: id,
							app: doc.app,
							api: doc.api,
							message: 'Entity has been deleted'
						});
						removeWebHooks(id, _req);
						if (!originalDoc.permanentDeleteData) {
							doc._metadata.deleted = true;
							return doc.save(_req);
						} else {
							return doc.remove(_req)
								.then(() => {
									if (doc.draftVersion) {
										return draftCrudder.model.findOne({ _id: doc._id });
									}
								})
								.then(draftDoc => {
									if (draftDoc) {
										draftDoc.remove(_req);
									}
								})
								.catch(err => {
									logger.error(err);
								});
						}
					}
				});
		})
		.then(() => {
			odputils.eventsUtil.publishEvent('EVENT_DS_DELETE', 'dataService', _req, originalDoc);
			smHooks.deleteAudit(originalDoc.app + '.' + originalDoc.collectionName, _req);
		})
		.catch(err => {
			logger.error(err);
			if (!_res.headersSent)
				_res.status(500).send(err.message);
			if (err.message !== '____CUSTOM_ENTITY_STOP_MSG_____') {
				deployUtil.updateDocument(crudder.model, {
					_id: id
				}, {
					status: 'Undeployed'
				}, _req)
					.catch(e => logger.error(e.message));
			}
		});
};

e.documentCount = (_req, _res) => {
	let id = _req.swagger.params.id.value;
	const ids = _req.query.serviceIds ? _req.query.serviceIds.split(',') : [];
	const filter = {
		'_metadata.deleted': false
	};
	if (id && id !== 'all') {
		filter._id = id;
	} else if (ids.length > 0) {
		filter._id = {
			$in: ids
		};
	} else {
		_res.status(200).json([]);
		return;
	}
	let functionName = id && id !== 'all' ? 'findOne' : 'find';
	return crudder.model[functionName](filter, 'collectionName app')
		.then(_doc => {
			if (_doc) {
				if (Array.isArray(_doc)) {
					return Promise.all(_doc.map(e => {
						return global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${e.app}`).collection(e.collectionName).count()
							.then(_count => {
								return {
									_id: e._id,
									count: _count
								};
							});
					}));
				} else {
					return global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${_doc.app}`).collection(_doc.collectionName).count();
				}
			} else {
				_res.status(404).json({
					message: 'No service found with id ' + id
				});
			}
		}).then(_count => {
			_res.status(200).json(_count);
		}).catch(err => {
			logger.error(err.message);
			if (!_res.headersSent) {
				_res.status(500).json({
					message: err.message
				});
			}
		});
};

e.deleteApp = function (_req, _res) {
	let app = _req.swagger.params.app.value;
	let socket = _req.app.get('socket');
	crudder.model.find({
		'app': app
	}, '_id')
		.then(_services => {
			let ids = _services.map(_s => _s.id);
			_res.json({
				message: 'Removing ' + ids + ' services'
			});
			return Promise.all(ids.map(id => destroyDeployment(id, 0, _req)));
		})
		.then(docs => {
			if (docs) {
				let promises = docs.map(doc => {
					deployUtil.sendToSocket(socket, 'serviceStatus', {
						_id: doc._id,
						app: doc.app,
						message: 'Undeployed'
					});
					deployUtil.deleteServiceInUserMgmt(doc._id, _req);
					deployUtil.deleteServiceInWorkflow(doc._id, _req);
					dropCollections(doc.collectionName, `${process.env.DATA_STACK_NAMESPACE}-${doc.app}`);
					deployUtil.sendToSocket(socket, 'deleteService', {
						_id: doc._id,
						app: doc.app,
						message: 'Entity has been deleted'
					});
					removeWebHooks(doc._id, _req);
					return doc.remove(_req);
				});
				return Promise.all(promises);
			}
		})
		.then(() => mongoose.model('globalSchema').find({
			'app': app
		}, '_id'))
		.then(docs => {
			if (docs) {
				return Promise.all(docs.map(doc => doc.remove(_req)));
			}
		})
		.catch(err => {
			logger.error(err.message);
			if (!_res.headersSent) {
				_res.status(500).json({
					message: err.message
				});
			}
		});
};
// change the status of service

function deleteLogs(srvcId, action) {
	logger.info('service id is', srvcId);
	logger.info('action is ', action);
	logger.info('url is', envConfig.baseUrlMON + `/appCenter/${srvcId}/${action}/purge`);
	let URL = envConfig.baseUrlMON + `/appCenter/${srvcId}/${action}/purge`;
	if (action === 'author-audit') {
		URL = envConfig.baseUrlMON + `/author/${srvcId}/audit/purge`;
	}
	if (action == 'audit') {
		// making two api calls to clear appcenter and author audits individually
		let URL2 = envConfig.baseUrlMON + `/author/${srvcId}/audit/purge`;
		return Promise.all([makePurgeApiCall(URL), makePurgeApiCall(URL2)]);
	} else {
		return makePurgeApiCall(URL);
	}
}

function makePurgeApiCall(url) {
	var options = {
		url: url,
		method: 'DELETE',
		headers: {
			'Content-Type': 'application/json'
		},
		json: true
	};
	return new Promise((_resolve, _reject) => request.delete(options, function (err, res) {
		if (err) {
			logger.error(err.message);
			_reject();
		}
		else if (!res) {
			logger.error('Monitoring service is down!');
			_reject({
				'message': 'Monitoring service is down!'
			});
		}
		else if (res) _resolve();
	}));
}

e.changeStatus = function (req, res) {
	let id = req.swagger.params.id.value;
	let status = req.swagger.params.status.value;
	let socket = req.app.get('socket');
	let relatedService = [];
	crudder.model.findOne({ _id: id })
		.then(data => {
			if (data && data.relatedSchemas && data.relatedSchemas.incoming) {
				data.relatedSchemas.incoming.forEach(doc => relatedService.push(doc));
			}
			if (data && data.status == 'Maintenance') {
				res.json({
					status: 'Maintenance',
					message: 'In Maintenance ',
					relatedService: relatedService,
					maintenanceInfo: data.maintenanceInfo
				});
			}
			else {
				let outRelationIds = data.relatedSchemas.outgoing.map(_d => _d.service);
				let outgoingAPIs;
				return crudder.model.find({ _id: { $in: outRelationIds } }, { app: 1, api: 1, _id: 1, port: 1, relatedSchemas: 1 }).lean(true)
					.then((inSrvc => {
						outgoingAPIs = { 'USER': { url: `${envConfig.baseUrlUSR}/usr` } };
						inSrvc.forEach(_d => {
							outgoingAPIs[_d._id] = _d;
							outgoingAPIs[_d._id].url = `/api/c/${_d.app}${_d.api}`;
						});
						return crudder.model.findOneAndUpdate({
							_id: id
						}, {
							status: status, '_metadata.lastUpdated': new Date()
						}, {
							runValidators: true
						});

					}))
					.then(doc => {
						if (doc) {
							if (doc.status !== 'Active') {
								logger.info('Service status of ' + doc._id + ' changed to ' + status);
								deployUtil.sendToSocket(socket, 'serviceStatus', {
									message: 'Deployed',
									_id: id,
									app: doc.app,
									port: doc.port,
									api: doc.api
								});
							}
						}
						res.json({
							message: 'Status changed',
							outgoingAPIs: outgoingAPIs
						});
					})
					.catch(err => {
						logger.error(err.message);
						res.status(500).json({
							message: err.message
						});
					});


			}

		});
};

e.StatusChangeFromMaintenance = function (req, res) {
	let relatedService = [];
	let id = req.swagger.params.id.value;
	let socket = req.app.get('socket');
	let _sd = {};
	let outgoingAPIs;
	return findCollectionData(id)
		.then(data => {
			if (data) {
				_sd = data;
				relatedService.push(_sd._id);
				if (data && data.relatedSchemas && data.relatedSchemas.incoming) {
					data.relatedSchemas.incoming.forEach(doc => relatedService.push(doc.service));
				}
				let promises = relatedService.map(id => {
					return mongoose.connection.db.collection('services').findOneAndUpdate({ _id: id }, { $set: { status: 'Undeployed', maintenanceInfo: null } }, { runValidators: true })
						.then(doc => {
							if (doc) {
								if (doc.status !== 'Active') {
									deployUtil.sendToSocket(socket, 'serviceStatus', {
										message: 'Undeployed',
										_id: id,
										app: doc.app,
										port: doc.port,
										api: doc.api
									});
								}
							}
						});
				});
				return Promise.all(promises)
					.then(() => {
						return scaleDeployments(req, socket, relatedService, null, 0);
					})
					.then(() => {
						return scaleDeploymentsToOriginal(req, socket, relatedService, null, 0);
					})
					.then(() => {
						if (_sd._id) {
							return mongoose.connection.db.collection('workflow').remove({ serviceId: _sd._id });
						}
					})
					.then(() => {
						if (_sd._id) {
							return deleteLogs(_sd._id, 'log');
						}
					})
					.then(() => {
						if (_sd._id) {
							return deleteLogs(_sd._id, 'audit');
						}
					})
					.then(() => {
						let outRelationIds = data.relatedSchemas.outgoing.map(_d => _d.service);
						return crudder.model.find({ _id: { $in: outRelationIds } }, { app: 1, api: 1, _id: 1, port: 1, relatedSchemas: 1 });
					})
					.then(inSrvc => {
						outgoingAPIs = { 'USER': { url: `${envConfig.baseUrlUSR}/usr` } };
						inSrvc.forEach(_d => {
							outgoingAPIs[_d._id] = _d;
							outgoingAPIs[_d._id].url = `/api/c/${_d.app}${_d.api}`;
						});
						res.json({
							message: 'Status changed',
							outgoingAPIs: outgoingAPIs
						});
					});
			}
		});
};

function getIdCounter(serviceId, app) {
	return crudder.model.findOne({ _id: serviceId, '_metadata.deleted': false }, 'collectionName')
		.then(_doc => {
			if (_doc) {
				var dbName = `${process.env.DATA_STACK_NAMESPACE}` + '-' + app;
				return global.mongoConnection.db(dbName).collection('counters').findOne({ _id: _doc.collectionName }, { next: 1 });
			}
		})
		.then(_d => {
			if (_d) {
				return _d.next;
			}
		});
}


e.startAllServices = (_req, _res) => {
	var app = _req.swagger.params.app.value;
	let socket = _req.app.get('socket');
	crudder.model.find({
		'app': app,
		'status': 'Undeployed'
	})
		.then(docs => {
			if (docs) {
				let promises = docs.map(doc => {
					doc = doc.toObject();
					// doc.definition = JSON.parse(doc.definition);
					const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
					if (process.env.SM_ENV == 'K8s') {
						let instances = doc.instances ? doc.instances : 1;
						logger.info('Scaling to ' + instances);
						return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), instances)
							.then(_d => {
								if (_d.statusCode == 404) {
									return deployUtil.deployService(doc, socket, _req, false, false);
								}
							})
							.catch(err => {
								logger.error(err);
							});
					}
					return deployUtil.deployService(doc, socket, _req, false, false);

				});
				_res.status(202).json({
					message: 'Request to start all data services has been received'
				});
				return Promise.all(promises);
			} else {
				_res.status(400).json({
					message: 'No entity found'
				});
			}
		})
		.catch(e => {
			logger.error(e.message);
			if (!_res.headersSent) _res.status(500).json({
				message: e.message
			});
		});
};


e.stopAllServices = (_req, _res) => {
	let app = _req.swagger.params.app.value;
	let socket = _req.app.get('socket');
	crudder.model.find({
		'app': app,
		status: 'Active'
	})
		.then(_services => {
			let promises = _services.map(doc => {
				if (process.env.SM_ENV == 'K8s') {
					logger.info('Scaling down to 0');
					const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
					return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), 0)
						.then(_d => {
							let instances = _d && _d.status && _d.status.replicas ? _d.status.replicas : null;
							logger.info('Instances at time of undeploying ' + instances);
							if (doc && instances) {
								doc.instances = instances;
								return doc.save(_req);
							} else {
								return doc;
							}
						});
				}
				return destroyDeployment(doc._id, 0, _req);
			});
			_res.status(202).json({
				message: 'Request to stop all data services has been received'
			});
			return Promise.all(promises);
		})
		.then(docs => {
			let ids = docs.map(doc => doc._id);
			docs.forEach(doc => {
				deployUtil.sendToSocket(socket, 'serviceStatus', {
					_id: doc._id,
					app: doc.app,
					message: 'Undeployed'
				});
			});
			ids.forEach(id => {
				crudder.model.findOne({
					_id: id
				})
					.then(doc => {
						if (doc) {
							doc.status = 'Undeployed';
							doc.save(_req);
						}
					});
			});
		})
		.catch(err => {
			logger.error(err);
			if (!_res.headersSent)
				_res.status(500).send(err.message);
		});
};

e.repairService = (_req, _res) => {
	let id = _req.swagger.params.id.value;
	return crudder.model.findOne({
		_id: id
	})
		.then(_d => {
			_d.status = 'Pending';
			return _d.save(_req);
		})
		.then(_d => {
			_res.status(202).json({
				message: 'Repair Process Started.....'
			});
			logger.debug(_d);
			return updateDeployment(_req, _res, _d.toObject());
		})
		.catch(err => {
			logger.error(err.message);
			if (!_res.headersSent) {
				_res.status(500).json({
					message: err.message
				});
			}
		});
};

function updateDeployment(req, res, ds) {
	let srvcDoc = JSON.parse(JSON.stringify(ds));
	let socket = req.app.get('socket');
	return k8s.deploymentDelete(ds)
		.then(_d => {
			logger.info('Deployment deleted');
			logger.debug(_d);
			return k8s.serviceDelete(srvcDoc);
		})
		.then(_d => {
			logger.info('Service deleted');
			logger.debug(_d);
			// srvcDoc.definition = JSON.parse(srvcDoc.definition);
			return k8s.serviceStart(srvcDoc);
		})
		.then(_d => {
			logger.info('Service started');
			logger.debug(_d);
			return deployUtil.deployService(srvcDoc, socket, req, false, false);
		})
		.catch(err => {
			logger.error(err.message);
			if (!res.headersSent) {
				res.status(500).json({
					message: err.message
				});
			}
		});
}

e.getCounter = (_req, _res) => {
	let id = _req.swagger.params.id.value;
	let app = _req.swagger.params.app.value;
	return getIdCounter(id, app)
		.then(_c => {
			if (_c) {
				_res.status(200).json(_c);

			} else {
				var counter = { 'initialCounter': 1 };
				_res.status(200).json(counter.initialCounter);
			}
		})
		.catch(err => {
			logger.error(err.message);
			_res.status(500).json({
				message: err.message
			});
		});
};

let initDone = false;
e.readiness = function (req, res) {
	if (!initDone) {
		return require('../../util/init/init')()
			.then(() => {
				initDone = true;
				return res.status(200).json();
			});
	}
	return res.status(200).json();
	/*
	updateService()
		.then(() => {
			
		})
		.catch(err => {
			logger.error(err.message);
			return res.status(500).json();
		});
		*/

};

e.health = function (req, res) {
	if (mongoose.connection.readyState === 1 && client && client.nc && client.nc.connected) {
		return res.status(200).json();
	} else {
		return res.status(400).json();
	}
};

function changeStatusToMaintenance(req, ids, srvcId, status, message) {
	let socket = req.app.get('socket');
	let promises = ids.map(id => {
		return mongoose.connection.db.collection('services').findOneAndUpdate({ _id: id }, { $set: { status: status, maintenanceInfo: null } }, { runValidators: true })
			.then(doc => {
				if (doc) {
					if (doc.status !== 'Active') {
						logger.info('Service status of ' + id + ' changed to ' + status);
						deployUtil.sendToSocket(socket, 'serviceStatus', {
							message: 'Deployed',
							_id: id,
							app: doc.app,
							port: doc.port,
							api: doc.api
						});
					}
				}
			});
	});
	return Promise.all(promises)
		.then(() => {
			return mongoose.connection.db.collection('services').findOneAndUpdate({ _id: srvcId }, { $set: { status: status, maintenanceInfo: message } }, { runValidators: true });
		});
}

function scaleDeployments(req, socket, ids, srvcId, instance) {
	if (srvcId) ids.push(srvcId);
	let promises = ids.map(id => {
		return mongoose.connection.db.collection('services').findOne({ _id: id })
			.then(doc => {
				if (doc) {
					const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
					if (process.env.SM_ENV == 'K8s') {
						logger.info('Scaling of ' + id + 'to ' + instance);
						return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), instance)
							.catch(err => {
								logger.error(err);
							});
					}
				}
			});
	});
	return Promise.all(promises);
}

function scaleDeploymentsFromStart(req, socket, ids, srvcId, instance) {
	if (srvcId) ids.push(srvcId);
	let promises = ids.map(id => {
		return mongoose.connection.db.collection('services').findOne({ _id: id })
			.then(doc => {
				if (doc) {
					const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
					if (process.env.SM_ENV == 'K8s') {
						logger.info('Scaling of ' + id + 'to ' + instance);
						return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), instance)
							.then(_d => {
								logger.info('instances doc is ++++++++++++', _d);
								let instances = _d && _d.body && _d.body.status && _d.body.status.replicas ? _d.body.status.replicas : null;
								logger.info('instance is', instances);
								return mongoose.connection.db.collection('services').findOneAndUpdate({ _id: id }, { $set: { instances: instances } }, { runValidators: true });
							})
							.catch(err => {
								logger.error(err);
							});
					}
				}
			});
	});
	return Promise.all(promises);
}

function scaleDeploymentsToOriginal(req, socket, ids, srvcId) {
	if (srvcId) ids.push(srvcId);
	let promises = ids.map(id => {
		return mongoose.connection.db.collection('services').findOne({ _id: id })
			.then(doc => {
				if (doc) {
					logger.info('the value of instance in db', doc.instances);
					const ns = envConfig.dataStackNS + '-' + doc.app.toLowerCase().replace(/ /g, '');
					let instances = doc.instances ? doc.instances : 1;
					if (process.env.SM_ENV == 'K8s') {
						logger.info('Scaling of ' + id + 'to ' + instances);
						return kubeutil.deployment.scaleDeployment(ns, doc.api.split('/')[1].toLowerCase(), instances)
							.catch(err => {
								logger.error(err);
							});
					}
				}
			});
	});
	return Promise.all(promises);
}

e.purgeLogsService = function (req, res) {
	let id = req.swagger.params.id.value;
	let type = req.swagger.params.type.value;
	deleteLogs(id, type)
		.then(() => {
			res.status(200).json({});
		})
		.catch(err => {
			res.status(500).json({ 'message': err.message });
		});

};

e.purge = function (req, res) {
	let id = req.swagger.params.id.value;
	let _sd = {};
	let relatedService = [];
	let socket = req.app.get('socket');
	return findCollectionData(id)
		.then(data => {
			if (data) {
				_sd = data;
				//relatedService.push(data._id);
				if (data && data.relatedSchemas && data.relatedSchemas.incoming) {
					data.relatedSchemas.incoming.forEach(doc => relatedService.push(doc.service));
				}
				relatedService.push(_sd._id);
				return mongoose.connection.db.collection('services').find({ $and: [{ _id: { $in: relatedService } }, { status: { $ne: 'Active' } }] }).toArray()
					.then(data => {
						if (data.length > 0) {
							let serviceMsg = '';
							if (data.length == 1) {
								serviceMsg = 'Related Data Service: ' + data[0].name + ' is not Active ';
							} else if (data.length == 2) {
								serviceMsg = 'Related Data Services: ' + data[0].name + ' & ' + data[1].name + ' are not Active ';
							} else {
								serviceMsg = 'Data Services: ' + data[0].name + ',' + data[1].name + ' & ' + 'more are not Active ';
							}

							res.status(400).json({
								message: serviceMsg
							});
						}
						else {
							let message = { 'type': 'purge' };
							return changeStatusToMaintenance(req, relatedService, _sd._id, 'Maintenance', JSON.stringify(message))
								.then(() => {
									return res.status(202).json({ 'message': 'Accepted' });
								})
								.then(() => {
									return scaleDeploymentsFromStart(req, socket, relatedService, _sd._id, 0);
								})
								.then(() => {
									return scaleDeployments(req, socket, relatedService, _sd._id, 1);
								});
						}
					})
					.catch(err => {
						res.status(500).json({ message: err.message });
					});
			}
		});

};

e.lockDocumentCount = (req, res) => {
	let id = req.swagger.params.id.value;
	let _sd = {};
	let collectionName = null;
	let app = null;
	return findCollectionData(id)
		.then(data => {
			if (data) {
				_sd = data;
				collectionName = _sd.collectionName;
				app = _sd.app;
				let dbName = envConfig.isK8sEnv() ? `${envConfig.dataStackNS}-${app}` : `${envConfig.dataStackNS}-${app}`;

				return global.mongoConnection.db(dbName).collection(collectionName).find({ '_metadata.workflow': { $exists: true } }).count()
					.then(count => {
						res.status(200).json({ count: count });
					})
					.catch(err => {
						res.status(400).json({ message: err.message });
					});
			}

			else {
				res.status(400).json({});
			}
		});

};

function findCollectionData(Id) {
	return mongoose.connection.db.collection('services').findOne({ '_id': Id })
		.then(result => {
			return result;
		})
		.catch(err => {
			return err;
		});
}

function customShow(req, res) {
	let draft = req.swagger.params.draft.value;
	let id = req.swagger.params.id.value;
	if (draft) {
		draftCrudder.model.findOne({ _id: id })
			.then(_d => {
				if (_d) draftCrudder.show(req, res);
				else crudder.show(req, res);
			})
			.catch(err => {
				logger.error(err);
			});
	} else {
		crudder.show(req, res);
	}
}

function draftDelete(req, res) {
	let id = req.swagger.params.id.value;
	draftCrudder.model.findOne({ _id: id })
		.then(_d => {
			if (_d)
				return _d.remove(req);
		})
		.then(() => {
			return crudder.model.findOne({ _id: id });
		})
		.then(_d => {
			_d.draftVersion = null;
			odputils.eventsUtil.publishEvent('EVENT_DS_DISCARD_DRAFT', 'dataService', req, _d);
			return _d.save(req);
		}).then(() => {
			res.status(200).json({ message: 'Draft deleted for ' + id });
		})
		.catch(err => {
			res.status(500).json({ message: err.message });
			logger.error(err);
		});
}

function validateUserDeletion(req, res) {
	let id = req.swagger.params.userId.value;
	let app = req.swagger.params.app.value;
	let promise = [];
	let pr = [];
	let flag = false;
	crudder.model.find({ 'relatedSchemas.internal.users.0': { $exists: true }, app: app })
		.then(_d => {
			promise = _d.map(data => {
				let db = global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${data.app}`);
				let filter = data.relatedSchemas.internal.users.map(doc => {
					doc.filter = doc.filter.replace('{{id}}', id);
					return doc;
				});
				pr = filter.map(doc => {
					return db.collection(data.collectionName).find(JSON.parse(doc.filter)).count()
						.then(count => {
							if (count > 0 && doc.isRequired) {
								flag = true;
							}
						});
				});
				return Promise.all(pr)
					.then();
			});
			return Promise.all(promise)
				.then(() => {
					if (flag) {
						res.status(500).json({ message: 'Document is in use' });
					}
					else res.status(200).json({});
				});
		});
}

function userDeletion(req, res) {
	let id = req.swagger.params.userId.value;
	let app = req.swagger.params.app.value;
	let promise = [];
	let pr = [];
	crudder.model.find({ 'relatedSchemas.internal.users.0': { $exists: true }, app: app })
		.then(_d => {
			promise = _d.map(data => {
				let db = global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${data.app}`);
				let filter = data.relatedSchemas.internal.users.map(doc => doc.filter.replace('{{id}}', id));
				let path = data.relatedSchemas.internal.users.map(doc => doc.path);
				filter = filter.map(doc => JSON.parse(doc));
				filter.push({});
				return db.collection(data.collectionName).find({ $or: filter }).count()
					.then(_c => {
						let totalBatches = _c / 30;
						totalBatches = Math.ceil(totalBatches);
						let arr = [];
						for (let i = 0; i < totalBatches; i++) {
							arr.push(i);
						}
						return arr.reduce((_pr, cur, i) => {
							return _pr
								.then(() => {
									return db.collection(data.collectionName).find({ $or: filter }).limit(30).skip(30 * i).toArray();
								})
								.then(docs => {
									pr = docs.map(doc => {
										let updatedDocuments = updateDoc(path, doc, id);
										let _id = updatedDocuments._id;
										delete updatedDocuments._id;
										db.collection(data.collectionName).findOneAndUpdate({ '_id': _id }, { $set: updatedDocuments }, { upsert: true });
									});
									Promise.all(pr);
								});
						}, Promise.resolve());
					});
			});
			Promise.all(promise)
				.then();
		})
		.then(() => {
			res.status(200).json({});
		})
		.catch(err => {
			res.status(500).json({ message: err.message });
		});
}

function updateDoc(path, doc, id) {
	path.map(ftr => {
		if (!_.isEmpty(ftr)) {
			generateCodeToRemoveExtId(getSelect(JSON.parse(ftr), ''), doc, id);
		}
	});
	return doc;
}

function generateCodeToRemoveExtId(path, doc, docId) {
	let pathSplit = path.split('.');
	let key = pathSplit.shift();
	if (doc.constructor == {}.constructor && key && doc[key] && key != '_id') {
		if (Array.isArray(doc[key])) {
			let newKey = pathSplit.join('.');
			doc[key] = doc[key].filter(_d => generateCodeToRemoveExtId(newKey, _d, docId));
		} else {
			doc[key] = generateCodeToRemoveExtId(pathSplit.join('.'), doc[key], docId);
			return doc;
		}
	} else if (pathSplit.length == 0 && doc._id == docId) {
		return null;
	}
	return doc;
}

function getSelect(obj, key) {
	if (typeof obj == 'object') {
		let obKey = Object.keys(obj)[0];
		let newKey = key;
		if (obKey != '_self') newKey = key == '' ? obKey : key + '.' + obKey;
		return getSelect(obj[obKey], newKey);
	}
	else {
		return key;
	}
}

function getCalendarDSDetails(app) {
	return {
		name: app + ' Calendar',
		api: `/${_.camelCase(app + 'Calendar')}`,
		app: app,
		type: 'internal'
	};
}

/**
 * 
 * @param {*} dsDefinition 
 * This method creates DS with definition and does not do any validation apart from one mentioned in pre save/validate hooks.
 */
function createDSWithDefinition(req, dsDefinition) {
	logger.debug('Creating DS with definiton :: ', JSON.stringify(dsDefinition));
	let model = mongoose.model('services');
	let doc = new model(dsDefinition);
	let roles = rolesUtil.getDefaultRoles();
	return doc.save(req).then((_d) => {
		let serviceObj = _d;
		let permObj = {
			_id: serviceObj._id,
			app: serviceObj.app,
			entity: serviceObj._id,
			entityName: serviceObj.name,
			roles: rolesUtil.getDefaultRoles(),
			type: 'appcenter',
			fields: JSON.stringify(rolesUtil.getDefaultFields(roles.map(e => e.id), dsDefinition.definition, {})),
			definition: serviceObj.definition

		};
		doc.role = permObj;
		return deployUtil.postRolesUserMgmt(permObj, req);
	})
		.then(() => doc.save(req))
		.then((_d) => {
			doc = _d;
			return deployUtil.createServiceInUserMgmt(doc._id, req, {
				app: doc.app,
				name: doc.name
			});
		})
		.then(() => smHooks.createDSinMON(doc, req))
		.then(() => Promise.resolve(doc))
		.catch(err => {
			logger.error('Error in createDSWithDefinition :: ', err);
			return Promise.reject(err);
		});
}

function enableCalendar(req, res) {
	let app = req.body.app;
	let calendarDSDetails = getCalendarDSDetails(app);
	logger.debug('Enabling calendar DS for app :: ', calendarDSDetails);
	crudder.model.findOne(calendarDSDetails).then(ds => {
		if (ds) {
			logger.debug('Calendar DS found, deploying now');
			res.status(202).json({ message: 'Deploying calendar DS' });
			return updateDeployment(req, res, ds);
		} else {
			logger.debug('Creating calendar DS');
			let promises = [getNextPort(), smHooks.validateApp(req), apiUniqueCheck(calendarDSDetails.api, app), nameUniqueCheck(calendarDSDetails.name, app)];
			return Promise.all(promises).then(data => {
				calendarDSDetails.port = data[0];
				return createDSWithDefinition(req, getCalendarDSDefinition(calendarDSDetails))
					.then((ds) => {
						logger.debug('Calendar DS created :: ', ds);
						res.status(202).json({ message: 'Enabling calendar for ' + app });
						return updateDeployment(req, res, ds);
					});
			}).catch(err => {
				logger.error('Error in creating calendar ds :: ', err);
				res.status(400).json({ message: err.message });
			});
		}
	});
}

function disableCalendar(req, res) {
	let app = req.body.app;
	logger.debug('Disabling calendar for app :: ', app);
	let calendarDSDetails = getCalendarDSDetails(app);
	crudder.model.findOne(calendarDSDetails).then(ds => {
		if (ds) {
			logger.debug('Calendar DS found, destroying now');
			res.status(202).json({ message: 'Disabling Calendar for ' + app });
			return destroyDeployment(ds._id, 0, req).then(() => deployUtil.updateDocument(crudder.model, {
				_id: ds._id
			}, {
				status: 'Undeployed'
			}, req))
				.then(() => deployUtil.updatePMForCalendar(req, { status: 'Undeployed', app: app }))
				.catch((err) => { throw err; });
		} else {
			logger.debug('Calendar DS not found for ' + app);
			return res.status(404).json({ message: 'Calendar DS not found for ' + app });
		}
	}).catch(err => {
		logger.error('Error in disabling calendar for ', app);
		return res.status(400).json({ message: err.message });
	});
}

/**
 * 
 * @param {*} serviceId 
 * @param {*} projection 
 * get service details by id with projection
 */
function getServiceDetailsById(serviceId, projection) {
	return new Promise((resolve, reject) => {
		if (!projection) projection = {};
		crudder.model.findOne({ _id: serviceId }, projection)
			.then((doc) => {
				resolve(doc);
			}).catch((err) => {
				logger.error('Error in getServiceDetailsById :: ', err);
				reject(err);
			});
	});
}

/**
 * 
 * @param {*} app 
 * @param {*} collectionName 
 * @param {*} field 
 * Checks for field to be uninque for given collection and app
 */

function checkUniqueField(app, collectionName, field) {
	let aggregateQuery = [
		// To consider non null existing values
		{ '$match': {} },
		// Group by the field to check uniqueness for
		{
			'$group': {
				'_id': { value: '$' + field },
				'count': { '$sum': 1 }
			}
		},
		// Find any group with count more than one
		{
			'$match': {
				'count': { '$gt': 1 }
			}
		}
	];
	aggregateQuery[0]['$match'][field] = { '$ne': null };
	return new Promise((resolve, reject) => {
		global.mongoConnection.db(`${process.env.DATA_STACK_NAMESPACE}-${app}`)
			.collection(collectionName).aggregate(aggregateQuery).toArray()
			.then(result => {
				let res = {};
				res[field] = false;
				if (result && result.length == 0)
					res[field] = true;
				else
					logger.debug('result of field ' + field + ' :: ' + JSON.stringify(result));
				resolve(res);
			}).catch(err => {
				logger.error('Error in checkUniqueField :: ', err);
				reject(err);
			});
	});
}

/**
 * 
 * @param {*} req 
 * @param {*} res 
 * Checks if given fields can be unique for given service Id.
 */

function checkUnique(req, res) {
	let serviceId = req.swagger.params.id.value;
	let fields = req.swagger.params.fields.value;
	fields = fields.split(',');
	getServiceDetailsById(serviceId, { app: 1, collectionName: 1 })
		.then(srvcDetails => {
			let promiseArr = fields.map(field => checkUniqueField(srvcDetails.app, srvcDetails.collectionName, field));
			Promise.all(promiseArr).then((result) => {
				let response = {};
				result.forEach(r => Object.assign(response, r));
				res.json(response);
			}).catch(err => {
				logger.error('Error in checkUnique :: ', err);
				res.status(400).json({ message: err.message });
			});
		}).catch(err => {
			logger.error('Error in checkUnique :: ', err);
			res.status(400).json({ message: err.message });
		});
}

/**
 * 
 * @param {*} req 
 * @param {*} res 
 * Returns the map of status and count of DS for the status
 */
function countByStatus(req, res) {
	let filter = req.swagger.params.filter.value;
	if (filter) {
		if (typeof filter == 'string')
			filter = JSON.parse(filter);
	} else {
		filter = {};
	}
	filter['_metadata.deleted'] = false;
	let aggregateQuery = [
		{ $match: filter },
		{
			$group: {
				_id: '$status',
				count: { $sum: 1 }
			}
		}
	];
	crudder.model.aggregate(aggregateQuery).then((result) => {
		let response = {};
		let total = 0;
		result.forEach(rs => {
			response[rs._id] = rs.count;
			total += rs.count;
		});
		response['Total'] = total;
		return res.json(response);
	}).catch(err => {
		logger.error('Error in countByStatus :: ', err);
		return res.status(400).json({ message: err.message });
	});
}

module.exports = {
	create: e.createDoc,
	index: crudder.index,
	show: customShow,
	destroy: e.destroyService,
	update: e.updateDoc,
	health: e.health,
	readiness: e.readiness,
	count: crudder.count,
	startService: e.startAPIHandler,
	stopService: e.stopAPIHandler,
	deployService: e.deployAPIHandler,
	documentCount: e.documentCount,
	deleteApp: e.deleteApp,
	changeStatus: e.changeStatus,
	StatusChangeFromMaintenance: e.StatusChangeFromMaintenance,
	verifyHook: e.verifyHook,
	getCounter: e.getCounter,
	stopAllServices: e.stopAllServices,
	startAllServices: e.startAllServices,
	repairService: e.repairService,
	purge: e.purge,
	purgeLogsService: e.purgeLogsService,
	lockDocumentCount: e.lockDocumentCount,
	draftDelete: draftDelete,
	validateUserDeletion: validateUserDeletion,
	userDeletion: userDeletion,
	enableCalendar: enableCalendar,
	disableCalendar: disableCalendar,
	checkUnique: checkUnique,
	countByStatus: countByStatus
};