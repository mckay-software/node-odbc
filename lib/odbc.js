/*
  Copyright (c) 2013, Dan VerWeire <dverweire@gmail.com>
  Copyright (c) 2010, Lee Smith <notwink@gmail.com>

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted, provided that the above
  copyright notice and this permission notice appear in all copies.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
  WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
  MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
  ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
  WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
  ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
  OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

var odbc = require("bindings")("odbc_bindings")
  , SimpleQueue = require("./simple-queue")
  , util = require("util")
  ;

module.exports = function (options) {
  return new Database(options);
}

module.exports.debug = false;

module.exports.Database = Database;
module.exports.ODBC = odbc.ODBC;
module.exports.ODBCConnection = odbc.ODBCConnection;
module.exports.ODBCStatement = odbc.ODBCStatement;
module.exports.ODBCResult = odbc.ODBCResult;
module.exports.loadODBCLibrary = odbc.loadODBCLibrary;

module.exports.open = function (connectionString, options, cb) {
  var db;
  
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  
  options.connection = connectionString;
  db = new Database(options);
  
  db.open(connectionString, function (err) {
    cb(err, db);
  });
}

function Database(options) {
  var self = this;
  
  options = options || {};
  
  if (odbc.loadODBCLibrary) {
    if (!options.library && !module.exports.library) {
      throw new Error("You must specify a library when complied with dynodbc, "
        + "otherwise this jams will segfault.");
    }
    
    if (!odbc.loadODBCLibrary(options.library || module.exports.library)) {
      throw new Error("Could not load library. You may need to specify full "
        + "path.");
    }
  }
  
  self.odbc = (options.odbc) ? options.odbc : new odbc.ODBC();
  self.queue = new SimpleQueue();
  self.fetchMode = options.fetchMode || null;
  self.connected = false;
  self.connection = options.connection;
  self.connectTimeout = (options.hasOwnProperty('connectTimeout')) 
    ? options.connectTimeout
    : null
    ;
  self.loginTimeout = (options.hasOwnProperty('loginTimeout'))
    ? options.loginTimeout
    : null
    ;
}

//Expose constants
Object.keys(odbc.ODBC).forEach(function (key) {
  if (typeof odbc.ODBC[key] !== "function") {
    //On the database prototype
    Database.prototype[key] = odbc.ODBC[key];
    
    //On the exports
    module.exports[key] = odbc.ODBC[key];
  }
});

Database.prototype.open = function (connectionString, cb) {
  var self = this;
  if (!self.connection) {
	self.connection = connectionString;
  }

  if (typeof(connectionString) == "object") {
    var obj = connectionString;
    connectionString = "";
    
    Object.keys(obj).forEach(function (key) {
      connectionString += key + "=" + obj[key] + ";";
    });
  }
  
  self.odbc.createConnection(function (err, conn) {
    if (err) return cb(err);
    
    self.conn = conn;
    
    if (self.connectTimeout || self.connectTimeout === 0) {
      self.conn.connectTimeout = self.connectTimeout;
    }
   
    if (self.loginTimeout || self.loginTimeout === 0) {
      self.conn.loginTimeout = self.loginTimeout;
    }

    self.conn.open(connectionString, function (err, result) {
      if (err) return cb(err);
                   
      self.connected = true;
      
      return cb(err, result);
    });
  });
};

Database.prototype.openSync = function (connectionString) {
  var self =  this;
  
  self.conn = self.odbc.createConnectionSync();
  
  if (self.connectTimeout || self.connectTimeout === 0) {
    self.conn.connectTimeout = self.connectTimeout;
  }
  
  if (self.loginTimeout || self.loginTimeout === 0) {
    self.conn.loginTimeout = self.loginTimeout;
  }
  
  if (typeof(connectionString) == "object") {
    var obj = connectionString;
    connectionString = "";
    
    Object.keys(obj).forEach(function (key) {
      connectionString += key + "=" + obj[key] + ";";
    });
  }
  
  var result = self.conn.openSync(connectionString);
  
  if (result) {
    self.connected = true;
  }
  
  return result;
}

Database.prototype.close = function (cb) {
  var self = this;
  
  self.queue.push(function (next) {
    //check to see if conn still exists (it's deleted when closed)
    if (!self.conn) {
      if (cb) cb(null);
      return next();
    }

    self.conn.close(function (err) {
      self.connected = false;
      delete self.conn;
      
      if (cb) cb(err);
      return next();
    });
  });
};

Database.prototype.closeSync = function () {
  var self = this;
  
  var result = self.conn.closeSync();
  
  self.connected = false;
  delete self.conn;
  
  return result
}

Database.prototype.query = function (sql, params, cb) {
  var self = this;
  
  if (typeof(params) == 'function') {
    cb = params;
    params = null;
  }
  
   if (!self.connected) {
    return cb({ message : "Connection not open."}, [], false);
  }
  
  self.queue.push(function (next) {
    function cbQuery (initialErr, result) {
      fetchMore();
      
      function fetchMore() {
        if (self.fetchMode) {
          result.fetchMode = self.fetchMode;
        }
         
        result.fetchAll(function (err, data) {
          var moreResults, moreResultsError = null;
          
          try {
            moreResults = result.moreResultsSync();
          }
          catch (e) {
            moreResultsError = e;
            //force to check for more results
            moreResults = true;
          }
          
          //close the result before calling back
          //if there are not more result sets
          if (!moreResults) {
            result.closeSync();
          }
          
          cb(err || initialErr, data, moreResults);
          initialErr = null;
            
          while (moreResultsError) {
            try {
              moreResults = result.moreResultsSync();
              cb(moreResultsError, [], moreResults); // No errors left - still need to report the
                                                     // last one, though
              moreResultsError = null;
            } catch (e) {
              cb(moreResultsError, [], moreResults);
              moreResultsError = e;
            } 
          }
          
          if (moreResults) {
            return fetchMore();
          }
          else {
            return next();
          }
        });
      }
    }
	
	if (!self.conn || !self.conn.query) {
	  console.error(new Error('Cannot query closed connection, re-opening...'))
	  return self.open(self.connection, () => {
		if (params) {
          self.conn.query(sql, params, cbQuery);
        } else {
          self.conn.query(sql, cbQuery);
        }
	  })
	}

    if (params) {
      self.conn.query(sql, params, cbQuery);
    }
    else {
      self.conn.query(sql, cbQuery);
    }
  });
};

Database.prototype.queryResult = function (sql, params, cb) {
  var self = this;
  
  if (typeof(params) == 'function') {
    cb = params;
    params = null;
  }
  
  if (!self.connected) {
    return cb({ message : "Connection not open."}, null);
  }
  
  self.queue.push(function (next) {
    //ODBCConnection.query() is the fastest-path querying mechanism.
    if (params) {
      self.conn.query(sql, params, cbQuery);
    }
    else {
      self.conn.query(sql, cbQuery);
    }
    
    function cbQuery (err, result) {
      if (err) {
        cb(err, null);
        
        return next();
      }
      
      if (self.fetchMode) {
        result.fetchMode = self.fetchMode;
      }
      
      cb(err, result);
      
      return next();
    }
  });
};

Database.prototype.queryResultSync = function (sql, params) {
  var self = this, result;
  
  if (!self.connected) {
    throw ({ message : "Connection not open."});
  }
  
  if (params) {
    result = self.conn.querySync(sql, params);
  }
  else {
    result = self.conn.querySync(sql);
  }
  
  if (self.fetchMode) {
    result.fetchMode = self.fetchMode;
  }
  
  return result;
};

Database.prototype.querySync = function (sql, params) {
  var self = this, result;
  
  if (!self.connected) {
    throw ({ message : "Connection not open."});
  }
  
  if (params) {
    result = self.conn.querySync(sql, params);
  }
  else {
    result = self.conn.querySync(sql);
  }
  
  if (self.fetchMode) {
    result.fetchMode = self.fetchMode;
  }
  
  var data = result.fetchAllSync();
  
  result.closeSync();
  
  return data;
};

Database.prototype.beginTransaction = function (cb) {
  var self = this;
  
  self.conn.beginTransaction(cb);
  
  return self;
};

Database.prototype.endTransaction = function (rollback, cb) {
  var self = this;
  
  self.conn.endTransaction(rollback, cb);
  
  return self;
};

Database.prototype.commitTransaction = function (cb) {
  var self = this;
  
  self.conn.endTransaction(false, cb); //don't rollback
  
  return self;
};

Database.prototype.rollbackTransaction = function (cb) {
  var self = this;
  
  self.conn.endTransaction(true, cb); //rollback
  
  return self;  
};

Database.prototype.beginTransactionSync = function () {
  var self = this;
  
  self.conn.beginTransactionSync();
  
  return self;
};

Database.prototype.endTransactionSync = function (rollback) {
  var self = this;
  
  self.conn.endTransactionSync(rollback);
  
  return self;
};

Database.prototype.commitTransactionSync = function () {
  var self = this;
  
  self.conn.endTransactionSync(false); //don't rollback
  
  return self;
};

Database.prototype.rollbackTransactionSync = function () {
  var self = this;
  
  self.conn.endTransactionSync(true); //rollback
  
  return self;  
};

Database.prototype.columns = function(catalog, schema, table, column, callback) {
  var self = this;
  if (!self.queue) self.queue = [];
  
  callback = callback || arguments[arguments.length - 1];
  
  self.queue.push(function (next) {
    self.conn.columns(catalog, schema, table, column, function (err, result) {
      if (err) return callback(err, [], false);

      result.fetchAll(function (err, data) {
        result.closeSync();

        callback(err, data);
        
        return next();
      });
    });
  });
};

Database.prototype.tables = function(catalog, schema, table, type, callback) {
  var self = this;
  if (!self.queue) self.queue = [];
  
  callback = callback || arguments[arguments.length - 1];
  
  self.queue.push(function (next) {
    self.conn.tables(catalog, schema, table, type, function (err, result) {
      if (err) return callback(err, [], false);

      result.fetchAll(function (err, data) {
        result.closeSync();

        callback(err, data);
        
        return next();
      });
    });
  });
};

Database.prototype.describe = function(obj, callback) {
  var self = this;
  
  if (typeof(callback) != "function") {
    throw({
      error : "[node-odbc] Missing Arguments",
      message : "You must specify a callback function in order for the describe method to work."
    });
    
    return false;
  }
  
  if (typeof(obj) != "object") {
    callback({
      error : "[node-odbc] Missing Arguments",
      message : "You must pass an object as argument 0 if you want anything productive to happen in the describe method."
    }, []);
    
    return false;
  }
  
  if (!obj.database) {
    callback({
      error : "[node-odbc] Missing Arguments",
      message : "The object you passed did not contain a database property. This is required for the describe method to work."
    }, []);
    
    return false;
  }
  
  //set some defaults if they weren't passed
  obj.schema = obj.schema || "%";
  obj.type = obj.type || "table";
  
  if (obj.table && obj.column) {
    //get the column details
    self.columns(obj.database, obj.schema, obj.table, obj.column, callback);
  }
  else if (obj.table) {
    //get the columns in the table
    self.columns(obj.database, obj.schema, obj.table, "%", callback);
  }
  else {
    //get the tables in the database
    self.tables(obj.database, obj.schema, null, obj.type || "table", callback);
  }
};

Database.prototype.prepare = function (sql, cb) {
  var self = this;
  
  self.conn.createStatement(function (err, stmt) {
    if (err) return cb(err);
    
    stmt.queue = new SimpleQueue();
    
    stmt.prepare(sql, function (err) {
      if (err) return cb(err);
      
      return cb(null, stmt);
    });
  });
}

Database.prototype.prepareSync = function (sql, cb) {
  var self = this;
  
  var stmt = self.conn.createStatementSync();
  
  stmt.queue = new SimpleQueue();
    
  stmt.prepareSync(sql);
    
  return stmt;
}

//Proxy all of the asynchronous functions so that they are queued
odbc.ODBCStatement.prototype._execute = odbc.ODBCStatement.prototype.execute;
odbc.ODBCStatement.prototype._executeDirect = odbc.ODBCStatement.prototype.executeDirect;
odbc.ODBCStatement.prototype._executeNonQuery = odbc.ODBCStatement.prototype.executeNonQuery;
odbc.ODBCStatement.prototype._prepare = odbc.ODBCStatement.prototype.prepare;
odbc.ODBCStatement.prototype._bind = odbc.ODBCStatement.prototype.bind;

odbc.ODBCStatement.prototype.execute = function (params, cb) {
  var self = this;
  
  self.queue = self.queue || new SimpleQueue();
  
  if (!cb) {
    cb = params;
    params = null;
  }
  
  self.queue.push(function (next) {
    //If params were passed to this function, then bind them and
    //then execute.
    if (params) {
      self._bind(params, function (err) {
        if (err) {
          return cb(err);
        }
        
        self._execute(function (err, result) {
          cb(err, result);
          
          return next();
        });
      });
    }
    //Otherwise execute and pop the next bind call
    else {
      self._execute(function (err, result) {
        cb(err, result);
        
        //NOTE: We only execute the next queued bind call after
        // we have called execute() or executeNonQuery(). This ensures
        // that we don't call a bind() a bunch of times without ever
        // actually executing that bind. Not 
        self.bindQueue && self.bindQueue.next();
        
        return next();
      });
    }
  });
};

odbc.ODBCStatement.prototype.executeDirect = function (sql, cb) {
  var self = this;
  
  self.queue = self.queue || new SimpleQueue();
  
  self.queue.push(function (next) {
    self._executeDirect(sql, function (err, result) {
      cb(err, result);
      
      return next();
    });
  });
};

odbc.ODBCStatement.prototype.executeNonQuery = function (params, cb) {
  var self = this;
  
  self.queue = self.queue || new SimpleQueue();
  
  if (!cb) {
    cb = params;
    params = null;
  }
  
  self.queue.push(function (next) {
    //If params were passed to this function, then bind them and
    //then executeNonQuery.
    if (params) {
      self._bind(params, function (err) {
        if (err) {
          return cb(err);
        }
        
        self._executeNonQuery(function (err, result) {
          cb(err, result);
          
          return next();
        });
      });
    }
    //Otherwise executeNonQuery and pop the next bind call
    else {
      self._executeNonQuery(function (err, result) {
        cb(err, result);
        
        //NOTE: We only execute the next queued bind call after
        // we have called execute() or executeNonQuery(). This ensures
        // that we don't call a bind() a bunch of times without ever
        // actually executing that bind. Not 
        self.bindQueue && self.bindQueue.next();
        
        return next();
      });
    }
  });
};

odbc.ODBCStatement.prototype.prepare = function (sql, cb) {
  var self = this;
  
  self.queue = self.queue || new SimpleQueue();
  
  self.queue.push(function (next) {
    self._prepare(sql, function (err) {
      cb(err);
      
      return next();
    });
  });
};

odbc.ODBCStatement.prototype.bind = function (ary, cb) {
  var self = this;
  
  self.bindQueue = self.bindQueue || new SimpleQueue();
  
  self.bindQueue.push(function () {
    self._bind(ary, function (err) {
      cb(err);
      
      //NOTE: we do not call next() here because
      //we want to pop the next bind call only
      //after the next execute call
    });
  });
};


//proxy the ODBCResult fetch function so that it is queued
odbc.ODBCResult.prototype._fetch = odbc.ODBCResult.prototype.fetch;

odbc.ODBCResult.prototype.fetch = function (cb) {
  var self = this;

  self.queue = self.queue || new SimpleQueue();

  self.queue.push(function (next) {
    self._fetch(function (err, data) {
      if (cb) cb(err, data);

      return next();
    });
  });
};

module.exports.Pool = Pool;

Pool.count = 0;

function Pool (options) {
  var self = this;
  self.index = Pool.count++;
  self.availablePool = {};
  self.usedPool = {};
  self.odbc = new odbc.ODBC();
  self.options = options || {}
  self.options.odbc = self.odbc;
}

Pool.prototype.open = function (connectionString, callback) {
  var self = this
    , db
    ;

  //check to see if we already have a connection for this connection string
  if (self.availablePool[connectionString] && self.availablePool[connectionString].length) {
    db = self.availablePool[connectionString].shift()
    self.usedPool[connectionString].push(db)

    callback(null, db);
  }
  else {
    db = new Database(self.options);
    db.realClose = db.close;
    
    db.close = function (cb) {
      //call back early, we can do the rest of this stuff after the client thinks
      //that the connection is closed.
      cb(null);
      
      
      //close the connection for real
      //this will kill any temp tables or anything that might be a security issue.
      db.realClose(function () {
         //remove this db from the usedPool
         self.usedPool[connectionString].splice(self.usedPool[connectionString].indexOf(db), 1);

        //re-open the connection using the connection string
        db.open(connectionString, function (error) {
          if (error) {
            console.error(error);
            return;
          }
          
          //add this clean connection to the connection pool
          self.availablePool[connectionString] = self.availablePool[connectionString] || [];
          self.availablePool[connectionString].push(db);
          exports.debug && console.dir(self);
        });
      });
    };
    
    db.open(connectionString, function (error) {
      exports.debug && console.log("odbc.js : pool[%s] : pool.db.open callback()", self.index);

      self.usedPool[connectionString] = self.usedPool[connectionString] || [];
      self.usedPool[connectionString].push(db);

      callback(error, db);
    });
  }
};

Pool.prototype.close = function (callback) {
  var self = this
    , required = 0
    , received = 0
    , connections
    , key
    , x
    ;

  exports.debug && console.log("odbc.js : pool[%s] : pool.close()", self.index);
  //we set a timeout because a previous db.close() may
  //have caused the a behind the scenes db.open() to prepare
  //a new connection
  setTimeout(function () {
    //merge the available pool and the usedPool
    var pools = {};

    for (key in self.availablePool) {
      pools[key] = (pools[key] || []).concat(self.availablePool[key]);
    }

    for (key in self.usedPool) {
      pools[key] = (pools[key] || []).concat(self.usedPool[key]);
    }

    exports.debug && console.log("odbc.js : pool[%s] : pool.close() - setTimeout() callback", self.index);
    exports.debug && console.dir(pools);

    if (Object.keys(pools).length == 0) {
      return callback();
    }

    for (key in pools) {
      connections = pools[key];
      required += connections.length;

      exports.debug && console.log("odbc.js : pool[%s] : pool.close() - processing pools %s - connections: %s", self.index, key, connections.length);

      for (x = 0 ; x < connections.length; x ++) {
        (function (x) {
          //call the realClose method to avoid
          //automatically re-opening the connection
          exports.debug && console.log("odbc.js : pool[%s] : pool.close() - calling realClose() for connection #%s", self.index, x);

          connections[x].realClose(function () {
            exports.debug && console.log("odbc.js : pool[%s] : pool.close() - realClose() callback for connection #%s", self.index, x);
            received += 1;

            if (received === required) {
              callback();

              //prevent mem leaks
              self = null;
              connections = null;
              required = null;
              received = null;
              key = null;

              return;
            }
          });
        })(x);
      }
    }
  }, 2000);
};
