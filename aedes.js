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

module.exports = Aedes

function Aedes (opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  opts = opts || {}
  opts.concurrency = opts.concurrency || 100

  this.id = shortid()
  this.counter = 0
  this.mq = opts.mq || mqemitter(opts)
  this.handle = function handle (conn) {
    // return, just to please standard
    // in theory we should store these
    // unconnected client somewhere,
    // and if they don't send a CONNECT
    // packet, kill them
    return new Client(that, conn)
  }
  this.persistence = opts.persistence || memory()
  this.persistence.broker = this
  this._parallel = parallel()
  this._series = series()
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
    // first do a suback
    done()

    var stream = broker.persistence.createRetainedStream(topic)

    stream.pipe(through.obj(function (packet, enc, cb) {
      func(packet, cb)
    }))
  })
}

Aedes.prototype.unsubscribe = function (topic, func, done) {
  this.mq.removeListener(topic, func, done)
}
