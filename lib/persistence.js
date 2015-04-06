
var from2   = require('from2')
  , Qlobber = require('qlobber').Qlobber

function MemoryPersistence() {
  if (!(this instanceof MemoryPersistence)) {
    return new MemoryPersistence()
  }

  this._retained = []
  this._subscriptions = []
}

MemoryPersistence.prototype.storeRetained = function(packet, cb) {
  this._retained = this._retained.filter(function(p) {
    return p.topic !== packet.topic
  })

  if (packet.payload.length > 0) this._retained.push(packet)

  setImmediate(cb)
  return this
}

function matchingStream(current, pattern) {
  var matcher = new Qlobber({
      wildcard_one: '+'
    , wildcard_some: '#'
    , separator: '/'
  })

  matcher.add(pattern, true)

  return from2.obj(function match(size, next) {
    var entry

    while (entry = current.shift()) {
      if (matcher.match(entry.topic).length > 0) {
        next(null, entry)
        return
      }
    }

    if (!entry)
      this.push(null)
  })
}

MemoryPersistence.prototype.createRetainedStream = function(pattern) {
  return matchingStream([].concat(this._retained), pattern)
}

MemoryPersistence.prototype.persistSubscriptions = function(clientId, subs, cb) {
  this._subscriptions[clientId] = subs
  setImmediate(cb)
}

MemoryPersistence.prototype.subscriptionsByClient = function(clientId, cb) {
  cb(null, this._subscriptions[clientId] || [])
}

MemoryPersistence.prototype.subscriptionsByPattern = function(pattern, cb) {
  var that = this;
  var array = Object.keys(this._subscriptions).map(function(clientId) {
    var subs = that._subscriptions[clientId]
    return subs.map(function(sub) {
      return {
          clientId: clientId
        , topic: sub.topic
        , qos: sub.qos
      }
    })
  }).reduce(function(acc, entries) {
    return acc.concat(entries)
  }, [])
  return matchingStream(array, pattern)
}

MemoryPersistence.prototype.cleanSubscriptions = function(clientId, cb) {
  delete this._subscriptions[clientId]
  setImmediate(cb)
}

MemoryPersistence.prototype.destroy = function(cb) {
  this._retained = null
  if (cb) {
    setImmediate(cb)
  }
}

module.exports = MemoryPersistence
