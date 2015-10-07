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

  var heartbeatTopic = '$SYS/' + that.id + '/heartbeat'
  this._heartbeatInterval = setInterval(heartbeat, opts.heartbeatInterval)

  var bufId = new Buffer(that.id, 'utf8')

  function heartbeat () {
    that.publish({
      topic: heartbeatTopic,
      payload: bufId
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

  this.mq.on('$SYS/+/heartbeat', function storeBroker (packet, done) {
    that.brokers[packet.payload.toString()] = Date.now()
    done()
  })

  this.mq.on('$SYS/+/new/clients', function closeSameClients (packet, done) {
    var serverId = packet.topic.split('/')[1]
    var clientId = packet.payload.toString()

    if (that.clients[clientId] && serverId !== that.id) {
      that.clients[clientId].close(done)
    } else {
      done()
    }
  })

  // metadata
  this.connectedClients = 0
}

util.inherits(Aedes, EE)

function storeRetained (_, done) {
  var packet = this.packet
  if (packet.retain) {
    this.broker.persistence.storeRetained(packet, done)
  } else {
    done()
  }
}

function emitPacket (_, done) {
  this.broker.mq.emit(this.packet, done)
}

function enqueueOffline (_, done) {
  var that = this
  var packet = this.packet

  if (packet.qos > 0) {
    this.broker.persistence.subscriptionsByTopic(packet.topic, function (err, subs) {
      if (err) {
        // is this really recoverable?
        // let's just error the whole aedes
        that.broker.emit('error', err)
      }
      // TODO remove callback

      doEnqueues(that, subs, done)
    })
  } else {
    done()
  }
}

function doEnqueues (status, subs, done) {
  if (subs.length === 0) {
    done()
  } else {
    status.broker._parallel(
      status,
      doEnqueue, subs, done)
  }
}

function doEnqueue (sub, done) {
  this.broker.persistence.outgoingEnqueue(sub, this.packet, done)
}

function callPublished (_, done) {
  this.broker.published(this.packet, this.client, done)
  this.broker.emit('publish', this.packet, this.client)
}

var publishFuncs = [
  storeRetained,
  enqueueOffline,
  emitPacket,
  callPublished
]
Aedes.prototype.publish = function (packet, client, done) {
  if (typeof client === 'function') {
    done = client
    client = null
  }
  var p = new Packet(packet, this)
  this._series(new PublishState(this, client, p), publishFuncs, null, done)
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
  var that = this
  if (this.clients[client.id]) {
    // moving out so we wait for this, so we don't
    // unregister a good client
    this.clients[client.id].close(function () {
      that._finishRegisterClient(client)
    })
  } else {
    this._finishRegisterClient(client)
  }
}

Aedes.prototype._finishRegisterClient = function (client) {
  this.connectedClients++
  this.clients[client.id] = client
  this.emit('client', client)
  this.publish({
    topic: '$SYS/' + this.id + '/new/clients',
    payload: new Buffer(client.id, 'utf8')
  }, noop)
}

Aedes.prototype.unregisterClient = function (client) {
  this.connectedClients--
  delete this.clients[client.id]
  this.emit('clientDisconnect', client)
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

Aedes.prototype.published = function (packet, client, done) {
  done(null)
}

function PublishState (broker, client, packet) {
  this.broker = broker
  this.client = client
  this.packet = packet
}

function noop () {}
