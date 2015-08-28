'use strict'

var mqemitter = require('mqemitter')
var EE = require('events').EventEmitter
var Client = require('./lib/client')
var util = require('util')
var memory = require('./lib/persistence')
var through = require('through2')
var parallel = require('fastparallel')
var series = require('fastseries')
var shortid = require('shortid')
var Packet = require('./lib/packet')
var bulk = require('bulk-write-stream')

module.exports = Aedes

function Aedes (opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  // TODO replace with extend
  opts = opts || {}
  opts.concurrency = opts.concurrency || 100
  opts.heartbeatInterval = opts.heartbeatInterval || 60000 // 1 minute
  opts.connectTimeout = opts.connectTimeout || 30000 // 30 secs

  this.id = shortid()
  this.counter = 0
  this.connectTimeout = opts.connectTimeout
  this.mq = opts.mq || mqemitter(opts)
  this.handle = function handle (conn) {
    // return, just to please standard
    return new Client(that, conn)
  }
  this.persistence = opts.persistence || memory()
  this.persistence.broker = this
  this._parallel = parallel()
  this._series = series()

  this.clients = {}
  this.brokers = {}

  var hearbeatTopic = '$SYS/' + that.id + '/heartbeat'
  this._heartbeatInterval = setInterval(heartbeat, opts.hearbeatInterval)

  function heartbeat () {
    that.publish({
      topic: hearbeatTopic,
      payload: new Buffer(that.id)
    }, noop)
  }

  function deleteOldBrokers (broker) {
    if (that.brokers[broker] + 3 * opts.heartbeatInterval < Date.now()) {
      delete that.brokers[broker]
    }
  }

  this._clearWillInterval = setInterval(function () {
    Object.keys(that.brokers).forEach(deleteOldBrokers)

    that.persistence
      .streamWill(that.brokers)
      .pipe(bulk.obj(receiveWills))
  }, opts.heartbeatInterval * 4)

  function receiveWills (chunks, done) {
    that._parallel(that, checkAndPublish, chunks, done)
  }

  function checkAndPublish (will, done) {
    var needsPublishing =
      !that.brokers[will.brokerId] ||
      that.brokers[will.brokerId] + 3 * opts.heartbeatInterval <
      Date.now()

    if (needsPublishing) {
      // randomize this, so that multiple brokers
      // do not publish the same wills at the same time
      that.publish(will, function (err) {
        if (err) {
          return done(err)
        }

        that.persistence.delWill({
          id: will.clientId
        }, done)
      })
    } else {
      done()
    }
  }

  this.mq.on('$SYS/+/hearbeat', function storeBroker (packet, done) {
    that.brokers[packet.payload.toString()] = Date.now()
  })

  this.mq.on('$SYS/+/new/clients', function closeSameClients (packet, done) {
    var serverId = packet.topic.split('/')[1]
    var clientId = packet.payload.toString()

    if (that.clients[clientId] && serverId !== that.id) {
      that.clients[clientId].close()
    }

    done()
  })
}

util.inherits(Aedes, EE)

function storeRetained (packet, done) {
  if (packet.retain) {
    this.persistence.storeRetained(packet, done)
  } else {
    done()
  }
}

function emitPacket (packet, done) {
  this.mq.emit(packet, done)
}

function enqueueOffline (packet, done) {
  var that = this

  if (packet.qos > 0) {
    this.persistence.subscriptionsByTopic(packet.topic, function (err, subs) {
      if (err) {
        // is this really recoverable?
        // let's just error the whole aedes
        that.emit('error', err)
      }
      // TODO remove callback

      doEnqueues(that, packet, subs, done)
    })
  } else {
    done()
  }
}

function EnqueuedStatus (packet, broker) {
  this.packet = packet
  this.broker = broker
}

function doEnqueues (broker, packet, subs, done) {
  if (subs.length === 0) {
    done()
  } else {
    broker._parallel(
      new EnqueuedStatus(packet, broker),
      doEnqueue, subs, done)
  }
}

function doEnqueue (sub, done) {
  this.broker.persistence.outgoingEnqueue(sub, this.packet, done)
}

var publishFuncs = [
  storeRetained,
  enqueueOffline,
  emitPacket
]
Aedes.prototype.publish = function (packet, done) {
  var p = new Packet(packet, this)
  this._series(this, publishFuncs, p, done)
}

Aedes.prototype.subscribe = function (topic, func, done) {
  var broker = this

  this.mq.on(topic, func, function subscribed () {
    if (done) {
      // first do a suback
      done()
    }

    var stream = broker.persistence.createRetainedStream(topic)

    stream.pipe(through.obj(function (packet, enc, cb) {
      func(packet, cb)
    }))
  })
}

Aedes.prototype.unsubscribe = function (topic, func, done) {
  this.mq.removeListener(topic, func, done)
}

Aedes.prototype.registerClient = function (client) {
  if (this.clients[client.id]) {
    this.clients[client.id].close()
  }
  this.clients[client.id] = client
  this.mq.emit({
    topic: '$SYS/' + this.id + '/new/clients',
    payload: new Buffer(client.id)
  })
}

Aedes.prototype.unregisterClient = function (client) {
  delete this.clients[client.id]
}

function closeClient (client, cb) {
  this.clients[client].close(cb)
}

Aedes.prototype.close = function (cb) {
  clearInterval(this._heartbeatInterval)
  clearInterval(this._clearWillInterval)
  this._parallel(this, closeClient, Object.keys(this.clients), cb || noop)
}

Aedes.prototype.authenticate = function (client, username, password, callback) {
  callback(null, true)
}

Aedes.prototype.authorizePublish = function (client, packet, callback) {
  callback(null)
}

Aedes.prototype.authorizeSubscribe = function (client, sub, cb) {
  cb(null, sub)
}

function noop () {}
