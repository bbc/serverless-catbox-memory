'use strict';

// Load modules

const Hoek = require('hoek');

// Declare internals

const internals = {};


internals.defaults = {
  maxByteSize: 100 * 1024 * 1024,          // 100MB
  allowMixedContent: false
};

// Provides a named reference for memory debugging
internals.MemoryCacheSegment = function MemoryCacheSegment() {
};

internals.MemoryCacheEntry = function MemoryCacheEntry(key, value, ttl, allowMixedContent) {

  let valueByteSize = 0;

  if (allowMixedContent && Buffer.isBuffer(value)) {
    this.item = new Buffer(value.length);
    // copy buffer to prevent value from changing while in the cache
    value.copy(this.item);
    valueByteSize = this.item.length;
  } else {
    // stringify() to prevent value from changing while in the cache
    this.item = JSON.stringify(value);
    valueByteSize = Buffer.byteLength(this.item);
  }

  this.stored = Date.now();
  this.ttl = ttl;
  this.expireTime = this.stored + ttl;

  // Approximate cache entry size without value: 144 bytes
  this.byteSize = 144 + valueByteSize + Buffer.byteLength(key.segment) + Buffer.byteLength(key.id);

};


exports = module.exports = internals.Connection = function MemoryCache(options) {

  Hoek.assert(this.constructor === internals.Connection, 'Memory cache client must be instantiated using new');
  Hoek.assert(
    !options || options.maxByteSize === undefined || options.maxByteSize >= 0, 'Invalid cache maxByteSize value'
  );
  Hoek.assert(
    !options ||
    options.allowMixedContent === undefined ||
    typeof options.allowMixedContent === 'boolean', 'Invalid allowMixedContent value'
  );

  this.settings = Hoek.applyToDefaults(internals.defaults, options || {});
  this.cache = null;
};


internals.Connection.prototype.start = function (callback) {

  callback = Hoek.nextTick(callback);

  if (!this.cache) {
    this.cache = {};
    this.byteSize = 0;
  }

  return callback();
};


internals.Connection.prototype.stop = function () {

  this.cache = null;
  this.byteSize = 0;
  return;
};


internals.Connection.prototype.isReady = function () {

  return !!this.cache;
};

internals.Connection.prototype.flushExpiredCacheItems = function () {

  if (!this.cache) {
    return;
  }

  const segments = Object.keys(this.cache);
  for (let i = 0; i < segments.length; ++i) {
    const segment = segments[i];
    const keys = Object.keys(this.cache[segment]);
    for (let j = 0; j < keys.length; ++j) {
      const key = keys[j];
      if (Date.now() > this.cache[segment][key].expireTime) {
        this.dropKey({ segment, id: key });
      }
    }
  }
};

internals.Connection.prototype.validateSegmentName = function (name) {

  if (!name) {
    return new Error('Empty string');
  }

  if (name.indexOf('\u0000') !== -1) {
    return new Error('Includes null character');
  }

  return null;
};


internals.Connection.prototype.get = function (key, callback) {

  callback = Hoek.nextTick(callback);

  if (!this.cache) {
    return callback(new Error('Connection not started'));
  }

  if (!this.cache[key.segment]) {
    return callback(null, null);
  }

  const envelope = this.cache[key.segment][key.id];

  if (!envelope) {
    return callback(null, null);
  }

  if (Date.now() > envelope.expireTime) {
    return this.drop(key, () => callback(null, null));
  }

  let value = null;

  if (Buffer.isBuffer(envelope.item)) {
    value = envelope.item;
  } else {
    value = internals.parseJSON(envelope.item);

    if (value instanceof Error) {
      return callback(new Error('Bad value content'));
    }
  }

  return callback(null, {
    item: value,
    stored: envelope.stored,
    ttl: envelope.ttl
  });
};


internals.Connection.prototype.set = function (key, value, ttl, callback) {

  callback = Hoek.nextTick(callback);

  if (!this.cache) {
    return callback(new Error('Connection not started'));
  }

  if (ttl > 2147483647) { // Math.pow(2, 31)
    return callback(new Error('Invalid ttl (greater than 2147483647)'));
  }

  let envelope = null;
  try {
    envelope = new internals.MemoryCacheEntry(key, value, ttl, this.settings.allowMixedContent);
  } catch (err) {
    return callback(err);
  }

  this.cache[key.segment] = this.cache[key.segment] || new internals.MemoryCacheSegment();
  const segment = this.cache[key.segment];
  const cachedItem = segment[key.id];

  if (cachedItem && Date.now() < cachedItem.expireTime) {
    this.byteSize -= cachedItem.byteSize; // If the item existed, decrement the byteSize as the value could be different
  }

  if (this.settings.maxByteSize) {
    if (this.byteSize + envelope.byteSize > this.settings.maxByteSize) {
      this.flushExpiredCacheItems();
    }
    if (this.byteSize + envelope.byteSize > this.settings.maxByteSize) {
      return callback(new Error('Unable to store cache entry, cache size limit reached.'));
    }
  }

  segment[key.id] = envelope;
  this.byteSize += envelope.byteSize;

  return callback(null);
};

internals.Connection.prototype.dropKey = function (key) {

  const segment = this.cache[key.segment];

  if (segment) {
    const item = segment[key.id];

    if (item) {
      this.byteSize -= item.byteSize;
    }

    delete segment[key.id];
  }
};

internals.Connection.prototype.drop = function (key, callback) {

  callback = Hoek.nextTick(callback);

  if (!this.cache) {
    return callback(new Error('Connection not started'));
  }

  this.dropKey(key);

  return callback();
};


internals.parseJSON = function (json) {

  let obj = null;

  try {
    obj = JSON.parse(json);
  } catch (err) {
    obj = err;
  }

  return obj;
};
