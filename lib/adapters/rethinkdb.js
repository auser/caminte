var safeRequire = require('../utils').safeRequire;
var r = safeRequire('rethinkdb');
var url = require('url');
var fs = require('fs');
var moment = require('moment');
var gpool = require('generic-pool');
var async = require('async');

exports.initialize = function initializeSchema(schema, callback) {
    if (!r)
        return;

    var s = schema.settings;

    if (schema.settings.rs) {

        s.rs = schema.settings.rs;
        if (schema.settings.url) {
            var uris = schema.settings.url.split(',');
            s.hosts = [];
            s.ports = [];
            uris.forEach(function(uri) {
                var purl = url.parse(uri);
                s.hosts.push(purl.hostname || 'localhost');
                s.ports.push(parseInt(purl.port || '28015', 10));
                if (!s.database)
                    s.database = purl.pathname.replace(/^\//, '');
                if (!s.username)
                    s.username = purl.auth && purl.auth.split(':')[0];
                if (!s.password)
                    s.password = purl.auth && purl.auth.split(':')[1];
            });
        }
        s.database = s.database || 'test';
    } else {
        if (schema.settings.url) {
            var purl = url.parse(schema.settings.url);
            s.host = purl.hostname;
            s.port = purl.port;
            s.database = purl.pathname.replace(/^\//, '');
            s.username = purl.auth && purl.auth.split(':')[0];
            s.password = purl.auth && purl.auth.split(':')[1];
        }
        s.host = s.host || 'localhost';
        s.port = parseInt(s.port || '28015', 10);
        s.database = s.database || 'test';
    }

    s.safe = s.safe || false;

    schema.adapter = new RethinkDB(s, schema);
    schema.adapter.pool = gpool.Pool({
        name: "caminte-rethink-pool",
        create: function(cb) {
            r.connect({host: s.host, port: s.port}, function(error, client) {
                if (error) {
                    return cb(error, null);
                }
                cb(null, client);
            });
        },
        destroy: function(client) {
            client.close();
        },
        max: s.poolMax || 10,
        min: s.poolMin || 1,
        idleTimeoutMillis: 30000,
        log: function(what, level) {
            if (level === "error") {
                fs.appendFile("caminte-rethink-pool.log", what + "\r\n");
            }
        }
    });
    process.nextTick(callback);
};

function RethinkDB(s, schema) {
    var i, n;
    this.name = 'rethink';
    this._models = {};
    this._foreignKeys = {};
    this.collections = {};
    this.schema = schema;
    this.s = s;
    this.database = s.database;
}

RethinkDB.prototype.connect = function(cb) {
    cb(); // connection pooling handles it
};

RethinkDB.prototype.define = function(descr) {
    if (!descr.settings)
        descr.settings = {};
    this._models[descr.model.modelName] = descr;
    this._foreignKeys[descr.model.modelName] = [];
};

// creates tables if not exists
RethinkDB.prototype.autoupdate = function(cb) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error) {
            throw error;
        }

        r.db(_this.database).tableList().run(client, function(error, cursor) {

            if (!error) {
                cursor.toArray(function(error, list) {
                    if (error) {
                        throw error;
                    }
                    async.each(Object.keys(_this._models), function(model, cb2) {
                        if (list.length === 0 || list.indexOf(model) < 0) {
                            r.db(_this.database).tableCreate(model).run(client, function(error) {
                                if (error) {
                                    return cb2(error);
                                }
                                createIndices();
                            });
                        } else {
                            createIndices();
                        }

                        function createIndices() {
                            var properties = _this._models[model].properties;
                            if (Object.keys(properties).length > 0) {
                                r.db(_this.database).table(model).indexList().run(client, function(error, cursor) {
                                    if (error) {
                                        return cb2(error);
                                    }
                                    cursor.toArray(function(error, list) {
                                        if (error) {
                                            return cb2(error);
                                        }
                                        async.each(Object.keys(properties), function(property, cb3) {
                                            if ((properties[property].index || _this._foreignKeys[model].indexOf(property) >= 0) && list.indexOf(property) < 0) {
                                                r.db(_this.database).table(model).indexCreate(property).run(client, function(error) {
                                                    if (error)
                                                        return cb3(error);
                                                    cb3();
                                                });
                                            } else {
                                                cb3();
                                            }
                                        }, function(err) {
                                            cb2(err);
                                        });
                                    });
                                });
                            } else {
                                cb2();
                            }
                        }
                    }, function(err) {
                        _this.pool.release(client);
                        cb(err);
                    });
                });
            } else {
                _this.pool.release(client);
                cb(error);
            }
        });
    });
};

// drops tables and re-creates them
RethinkDB.prototype.automigrate = function(cb) {
    this.autoupdate(cb);
};

// checks if database needs to be actualized
RethinkDB.prototype.isActual = function(cb) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        r.db(_this.database).tableList().run(client, function(error, cursor) {
            if (!error) {
                if (cursor.hasNext()) {
                    cursor.toArray(function(error, list) {
                        if (error) {
                            _this.pool.release(client);
                            return cb(error);
                        }
                        var actual = true;
                        async.each(Object.keys(_this._models), function(model, cb2) {
                            if (!actual)
                                return cb2();

                            var properties = _this._models[model].properties;
                            if (list.indexOf(model) < 0) {
                                actual = false;
                                cb2();
                            } else {
                                r.db(_this.database).table(model).indexList().run(client, function(error, cursor) {
                                    if (error)
                                        return cb2(error);

                                    cursor.toArray(function(error, list) {
                                        if (error)
                                            return cb2(error);

                                        Object.keys(properties).forEach(function(property) {
                                            if ((properties[property].index || _this._foreignKeys[model].indexOf(property) >= 0) && list.indexOf(property) < 0)
                                                actual = false;
                                        });
                                        cb2();
                                    });
                                });
                            }
                        }, function(err) {
                            _this.pool.release(client);
                            cb(err, actual);
                        });
                    });
                } else if (_this._models.length > 0) {
                    _this.pool.release(client);
                    cb(null, false);
                }
            } else {
                _this.pool.release(client);
                cb(error);
            }
        });
    });
};

RethinkDB.prototype.defineForeignKey = function(name, key, anotherName, cb) {
    this._foreignKeys[name].push(key);
    cb(null, String);
};

RethinkDB.prototype.create = function(model, data, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        if (data.id === null || data.id === undefined) {
            delete data.id;
        }
        Object.keys(data).forEach(function(key) {
            if (data[key] instanceof Date)
                data[key] = moment(data[key]).unix();
            if (data[key] === undefined)
                data[key] = null;
        });
        r.db(_this.database).table(model).insert(data).run(client, function(err, m) {
            _this.pool.release(client);
            err = err || m.first_error && new Error(m.first_error);
            if (m.generated_keys) {
                data.id = m.generated_keys[0];
            }
            callback(err, err ? null : data.id);
        });
    });
};

RethinkDB.prototype.save = function(model, data, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        Object.keys(data).forEach(function(key) {
            if (data[key] instanceof Date)
                data[key] = moment(data[key]).unix();
            if (data[key] === undefined)
                data[key] = null;
        });
        r.db(_this.database).table(model).insert(data, {upsert: true}).run(client, function(err, notice) {
            _this.pool.release(client);
            err = err || notice.first_error && new Error(notice.first_error);
            callback(err, notice);
        });
    });
};

RethinkDB.prototype.exists = function(model, id, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        r.db(_this.database).table(model).get(id).run(client, function(err, data) {
            _this.pool.release(client);
            callback(err, !!(!err && data));
        });
    });
};

RethinkDB.prototype.findById = function findById(model, id, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        r.db(_this.database).table(model).get(id).run(client, function(err, data) {
            if (data)
                Object.keys(data).forEach(function(key) {
                    if (_this._models[model].properties[key]['type']['name'] === "Date")
                        data[key] = moment.unix(data[key]).toDate();
                }.bind(_this));

            _this.pool.release(client);
            callback(err, data);
        }.bind(_this));
    });
};

RethinkDB.prototype.updateOrCreate = function updateOrCreate(model, data, callback) {
    var _this = this;
    _this.pool.acquire(function(error, client) {
        if (error) {
            throw error;
        }
        if (data.id === null || data.id === undefined) {
            delete data.id;
        }
        data.forEach(function(value, key) {
            if (value instanceof Date)
                data[key] = moment(value).unix();
            if (value === undefined)
                data[key] = null;
        });
        r.db(_this.database).table(model).insert(data, {upsert: true}).run(client, function(err, m) {
            _this.pool.release(client);
            err = err || m.first_error && new Error(m.first_error);
            callback(err, err ? null : m['generated_keys'][0]);
        });
    });
};

RethinkDB.prototype.destroy = function destroy(model, id, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        r.db(_this.database).table(model).get(id).delete().run(client, function(error, result) {
            _this.pool.release(client);
            callback(error);
        });
    });
};

RethinkDB.prototype.remove = function remove(model, filter, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        if (!filter) {
            filter = {};
        }

        var promise = r.db(_this.database).table(model);

        if (filter.where) {
            promise = _processWhere(_this, model, filter.where, promise);
        }

        if (filter.skip) {
            promise = promise.skip(filter.skip);
        } else if (filter.offset) {
            promise = promise.skip(filter.offset);
        }
        if (filter.limit) {
            promise = promise.limit(filter.limit);
        }

        _keys = _this._models[model].properties;
        _model = _this._models[model].model;

        promise.delete().run(client, function(error, cursor) {
            _this.pool.release(client);
            callback(error);
        });
    }, 0); // high-priority pooling
};

RethinkDB.prototype.all = function all(model, filter, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        if (!filter) {
            filter = {};
        }

        var promise = r.db(_this.database).table(model);

        if (filter.where) {
            promise = _processWhere(_this, model, filter.where, promise);
        }

        if (filter.order) {
            var keys = filter.order;
            if (typeof keys === 'string') {
                keys = keys.split(',');
            }
            keys.forEach(function(key) {
                var m = key.match(/\s+(A|DE)SC$/);
                key = key.replace(/\s+(A|DE)SC$/, '').trim();
                if (m && m[1] === 'DE') {
                    promise = promise.orderBy(r.desc(key));
                } else {
                    promise = promise.orderBy(r.asc(key));
                }
            });
        } else {
            // default sort by id
            promise = promise.orderBy(r.asc("id"));
        }

        if (filter.skip) {
            promise = promise.skip(filter.skip);
        } else if (filter.offset) {
            promise = promise.skip(filter.offset);
        }
        if (filter.limit) {
            promise = promise.limit(filter.limit);
        }

        _keys = _this._models[model].properties;
        _model = _this._models[model].model;

        promise.run(client, function(error, cursor) {
            if (error) {
                _this.pool.release(client);
                callback(error, null);
            }
            cursor.toArray(function(err, data) {
                if (err) {
                    _this.pool.release(client);
                    return callback(err);
                }

                data.forEach(function(element, index) {
                    Object.keys(element).forEach(function(key) {
                        if (!_keys.hasOwnProperty(key))
                            return;
                        if (_keys[key]['type']['name'] === "Date")
                            element[key] = moment.unix(element[key]).toDate();
                    });
                    data[index] = element;
                });

                _this.pool.release(client);

                if (filter && filter.include && filter.include.length > 0) {
                    _model.include(data, filter.include, callback);
                } else {
                    callback(null, data);
                }
            });
        });
    }, 0); // high-priority pooling
};

RethinkDB.prototype.destroyAll = function destroyAll(model, callback) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;
        r.db(_this.database).table(model).delete().run(client, function(error, result) {
            _this.pool.release(client);
            callback(error, result);
        });
    });
};

RethinkDB.prototype.count = function count(model, callback, where) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        var promise = r.db(_this.database).table(model);

        if (where && typeof where === "object")
            promise = _processWhere(_this, model, where, promise);

        promise.count().run(client, function(err, count) {
            _this.pool.release(client);
            callback(err, count);
        });
    });
};

RethinkDB.prototype.updateAttributes = function updateAttrs(model, id, data, cb) {
    var _this = this;

    _this.pool.acquire(function(error, client) {
        if (error)
            throw error;

        data.id = id;
        Object.keys(data).forEach(function(key) {
            if (data[key] instanceof Date)
                data[key] = moment(data[key]).unix();
            if (data[key] === undefined)
                data[key] = null;
        });
        r.db(_this.database).table(model).update(data).run(client, function(err, object) {
            _this.pool.release(client);
            cb(err, data);
        });
    });
};

RethinkDB.prototype.disconnect = function() {
    var _this = this;
    _this.pool.drain(function() {
        _this.pool.destroyAllNow();
    });
};

function _processWhere(_this, model, where, promise) {
    //Transform promise (a rethinkdb query) based on the given where clause.
    //Returns the modified promise
    var i, m, keys;
    var indexed = false;
    var queryParts = [];
    var queryExtra = [];
    Object.keys(where).forEach(function(k) {
        var spec, cond = where[k];
        var allConds = [];
        if (cond && cond.constructor.name === 'Object') {
            keys = Object.keys(cond);
            for (i = 0, m = keys.length; i < m; i++) {
                allConds.push([keys[i], cond[keys[i]]]);
            }
        }
        else {
            allConds.push([false, cond]);
        }
        var hasIndex = _this._models[model].properties[k].index || _this._foreignKeys[model].indexOf(k) >= 0;
        for (i = 0, m = allConds.length; i < m; i++) {
            spec = allConds[i][0];
            cond = allConds[i][1];
            if (cond instanceof Date) {
                cond = moment(cond).unix();
            }
            switch (spec) {
                case false:
                    if (!indexed && hasIndex) {
                        promise = promise.getAll(cond, {index: k});
                        indexed = true;
                    } else {
                        queryParts.push(r.row(k).eq(cond));
                    }
                    break;
                case 'between':
                    if (!indexed && hasIndex) {
                        promise = promise.between(cond[0], cond[1], {index: k});
                        indexed = true;
                    } else {
                        queryParts.push(r.row(k).ge(cond[0]).and(r.row(k).le(cond[1])));
                    }
                    break;
                case 'inq':
                    var expr1 = '(function(row) { return ' + JSON.stringify(cond) + '.indexOf(row.' + k + ') >= 0 })';
                    queryExtra.push(r.js(expr1));
                    break;
                case 'nin':
                    var expr2 = '(function(row) { return ' + JSON.stringify(cond) + '.indexOf(row.' + k + ') === -1 })';
                    queryExtra.push(r.js(expr2));
                    break;
                case 'gt':
                    queryParts.push(r.row(k).gt(cond));
                    break;
                case 'gte':
                    queryParts.push(r.row(k).ge(cond));
                    break;
                case 'lt':
                    queryParts.push(r.row(k).lt(cond));
                    break;
                case 'lte':
                    queryParts.push(r.row(k).le(cond));
                    break;
                case 'neq':
                    queryParts.push(r.row(k).ne(cond));
                    break;
            }
        }
    });

    var query;
    queryParts.forEach(function(comp) {
        if (!query) {
            query = comp;
        } else {
            query = query.and(comp);
        }
    });
    if (query) {
        promise = promise.filter(query);
    }
    queryExtra.forEach(function(comp) {
        promise = promise.filter(comp);
    });

    return promise;
}