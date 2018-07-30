var _ = require('lodash');
var moment = require('moment');
var Promise = require('bluebird');
var mongodb = Promise.promisifyAll(require('mongodb'));
var debug = require('debug')('lib:mongo');
var debugread = require('debug')('lib:mongo:read');
var debugcount = require('debug')('lib:mongo:count');
var nconf = require('nconf');

var dbConnection = function() {
    var url = nconf.get('mongodb');
    return mongodb
        .MongoClient
        .connectAsync(url)
        .disposer(function(db) {
            return db.close();
        });
};

var writeOne = function(cName, dataObject) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .insert(dataObject);
    })
    .return(dataObject);
};

var updateOne = function(cName, selector, updated) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .updateOne(selector, updated);
    })
    .return(updated);
};

/* better safe than sorry */
var upsertOne = function(cName, selector, updated) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .updateOne(selector, updated, {upsert: true});
    })
    .return(updated);
};

function writeMany(cName, dataObjects) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .insertMany(dataObjects);
    });
};

function read(cName, selector, sorter) {
    if(_.isUndefined(sorter)) sorter = {};
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .find(selector)
            .sort(sorter)
            .toArray();
    })
    .tap(function(rv) {
        debugread("read in %s by %j sort by %j → read %d objects", 
            cName, selector, sorter, _.size(rv) );
    });
};

function remove(cName, selector) {

    if(_.size(_.keys(selector)) === 0)
        throw new Error("Nope, you can't delete {} ");

    debug("Removing documents %j from %s", selector, cName);
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .remove(selector);
    });
};

var readLimit = function(cName, selector, sorter, limitN, past) {
    if(_.isNaN(past)) past = 0;
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .find(selector)
            .sort(sorter)
            .skip(past)
            .limit(limitN)
            .toArray()
    })
    .tap(function(rv) {
        debug("readLimit by %j →  gives %d objects", selector, _.size(rv) );
    })
    .catch(function(errstr) {
        var alarms = require('./alarms');
        alarms.reportAlarm({
            caller: "readLimit",
            what: errstr,
            info: { selector: selector, limit: limitN, sorter: sorter }
        });
        debug("Error in readLimit!: %s", errstr);
        return [];
    });
};

var countByMatch = function(cName, selector) {
    debugcount("countByMatch in %s by %j", cName, selector);
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .find(selector)
            .count();
    });
};

var aggregate = function(cName, match, group) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .aggregate([
                { $match: match },
                { $group: group }
            ])
            .toArray();
    })
    .tap(function(ret) {
        debug("aggregate %s match %s group %s → %d entries",
            cName, JSON.stringify(match),
            JSON.stringify(group), _.size(ret));
    });
};

var countByDay = function(cName, timeVarName, filter, aggext) {

    if(!_.startsWith(timeVarName, '$'))
        throw new Error("developer please: mongoVar wants '$'");

    var queryId = { 
        year:  { $year: timeVarName },
        month: { $month: timeVarName },
        day:   { $dayOfMonth: timeVarName }
    };

    if(_.isObject(aggext) && _.size(_.keys(aggext)) > 0) {
        /* for example: { user: "$userId" } */
        queryId = _.extend(queryId, aggext);
    }

    var totalQ = [
        { $match: filter },
        { $group: {
            _id: queryId,
            count: { $sum: 1 }
        }}];

    debug("countByDay on %s %j  → ", cName, filter);
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .aggregate(totalQ)
            .toArray()
            .catch(function(error) {
                var alarms = require('./alarms');
                alarms.reportAlarm({
                    caller: "countByDay",
                    what: error,
                    info: { cName: cName,
                            timeVarName: timeVarName,
                            filter: filter,
                            aggext: aggext
                    }
                });
                debug("mongo error: %s (%s)", error, cName);
                return [];
            });
    })
    .tap(function(done) {
        debug("← countByDay on %s F %j[%j] got %d",
            cName, filter, aggext, _.size(done));
    });
};

var countByObject = function(cName, idobj) {
    if(_.isUndefined(idobj)) idobj = {};
    debug("countByObject in %s by %j", cName, idobj);
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .aggregate([
                {
                  $group: {
                    _id: idobj,
                    count: { $sum: 1 }
                  }
                },
                { $sort: { count: -1 } }
            ])
            .toArray()
            .catch(function(error) {
                var alarms = require('./alarms');
                alarms.reportAlarm({
                    caller: "countByObject",
                    what: error,
                    info: { cName: cName, idobj: idobj }
                });
                debug("MongoQuery %s error: %s", cName, error);
                return [];
            });
    });
};

function updateMany(cName, elist) {
    /* elist is supposed to have "_id" field */
    _.each(elist, function(e) {
        if(_.isUndefined(e['id'])) {
            debug("Error with elements %s", JSON.stringify(e, undefined, 2));
            throw new Error("we need id in every element");
        }
    });
    debug("updateMany in %s with %d elements", cName, _.size(elist));
    return Promise.each(elist, function(e) {
        return Promise.using(dbConnection(), function(db) {
            return db
                .collection(cName)
                .update({'id': e.id}, e);
        });
    });
};

function lookup(cName, query, sequence) {

    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .aggregate([ query, sequence ])
            .toArray()
            .catch(function(error) {
                var alarms = require('./alarms');
                alarms.reportAlarm({
                    caller: "lookup",
                    what: error,
                    info: { cName: cName, query: query, sequence: sequence }
                });
                debug("MongoQuery %s error: %s", cName, error);
                return [];
            });
    });
};

function save(cName, doc) {
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .save(doc);
    });
};

function createIndex(cName, index, opt) {
    return Promise.using(dbConnection(), function(db) {
        return db.ensureIndex(cName, index, opt);
    })
    .tap(function(results) {
        debug("indexes created on %s: %j = %j", cName, index, results);
    });
};

function distinct(cName, field, query) {
    debug("distinct in %s for %s with %j", cName, field, query);
    return Promise.using(dbConnection(), function(db) {
        return db
            .collection(cName)
            .distinct(field, query);
    })
    .tap(function(results) {
        debug("distinct on %s, on %s: %d elements", cName, field, _.size(results));
    });
};

module.exports = {
    updateOne: updateOne,
    upsertOne: upsertOne,
    writeOne: writeOne,
    writeMany: writeMany,
    readLimit: readLimit,
    countByDay: countByDay,
    countByMatch: countByMatch,
    countByObject: countByObject,
    read: read,
    remove: remove,
    aggregate: aggregate,
    updateMany: updateMany,
    lookup: lookup,
    save: save,
    createIndex: createIndex,
    distinct: distinct
};
