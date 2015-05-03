
var from2   = require('from2')
  , Qlobber = require('qlobber').Qlobber

function MemoryPersistence() {
  if (!(this instanceof MemoryPersistence)) {
    return new MemoryPersistence()
  }

  this._retained = []
  this._subscriptions = []
  this._trie = new Qlobber({
      wildcard_one: '+'
    , wildcard_some: '#'
    , separator: '/'
  })
  this._outgoing = {}
}

MemoryPersistence.prototype.storeRetained = function(packet, cb) {
  this._retained = this._retained.filter(function(p) {
    return p.topic !== packet.topic
  })

  if (packet.payload.length > 0) this._retained.push(packet)

  cb(null)
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
        setImmediate(next, null, entry)
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

MemoryPersistence.prototype.addSubscriptions = function(client, subs, cb) {
  var stored = this._subscriptions[client.id]
    , trie   = this._trie

  if (!stored) {
    stored = []
    this._subscriptions[client.id] = stored
  }

  subs.map(function(sub){
    return {
        clientId: client.id
      , topic: sub.topic
      , qos: sub.qos
    }
  }).forEach(function(sub) {
    if (sub.qos > 0) {
      stored.push(sub)
      trie.add(sub.topic, sub)
    }
  })

  cb(null, client)
}

MemoryPersistence.prototype.removeSubscriptions = function(client, subs, cb) {
  var stored = this._subscriptions[client.id]
    , trie   = this._trie

  if (!stored) {
    stored = {}
    this._subscriptions[client.id] = stored
  }

  this._subscriptions[client.id] = stored.filter(function(storedSub) {
    var toKeep = subs.indexOf(storedSub.topic) < 0
    if (!toKeep) {
      trie.remove(storedSub.topic, storedSub)
    }
    return toKeep
  })

  cb(null, client)
}

MemoryPersistence.prototype.subscriptionsByClient = function(client, cb) {
  var subs = this._subscriptions[client.id] || null
  if (subs) {
    subs = subs.map(function(sub) {
      return {
          topic: sub.topic
        , qos: sub.qos
      }
    })
  }
  cb(null, subs, client)
}

MemoryPersistence.prototype.subscriptionsByTopic = function(pattern, cb) {
  cb(null, this._trie.match(pattern))
}

MemoryPersistence.prototype.cleanSubscriptions = function(client, cb) {
  var trie = this._trie

  if (this._subscriptions[client.id]) {
    this._subscriptions[client.id].forEach(function(sub) {
      trie.remove(sub.topic, sub)
    })

    delete this._subscriptions[client.id]
  }

  cb(null, client)
}

MemoryPersistence.prototype.outgoingEnqueue = function(sub, packet, cb) {
  var id = sub.clientId
    , queue = this._outgoing[id] || []

  this._outgoing[id] = queue

  queue[queue.length] = packet

  cb(null)
}

MemoryPersistence.prototype.outgoingStream = function(client) {
  var queue = this._outgoing[client.id] || []

  this._outgoing[client.id] = queue

  return from2.obj(function match(size, next) {
    var entry

    while (entry = queue.shift()) {
      setImmediate(next, null, entry)
      return
    }

    if (!entry)
      this.push(null)
  })
}

MemoryPersistence.prototype.destroy = function(cb) {
  this._retained = null
  if (cb) {
    cb(null)
  }
}

module.exports = MemoryPersistence
