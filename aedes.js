
var mqemitter   = require('mqemitter')
  , EE          = require('events').EventEmitter
  , Client      = require('./lib/client')
  , util        = require('util')
  , memory      = require('./lib/persistence')
  , through     = require('through2')
  , parallel    = require('fastparallel')
  , series      = require('fastseries')
  , shortid     = require('shortid')
  , Packet      = require('./lib/packet')

module.exports = Aedes

function Aedes(opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  opts = opts || {}
  opts.concurrency = opts.concurrency || 100

  this.id = shortid()
  this.counter = 0
  this.mq = opts.mq || mqemitter(opts)
  this.handle = function handle(conn) {
    new Client(that, conn)
  }
  this.persistence = opts.persistence || memory()
  this.persistence.broker = this
  this._parallel = parallel()
  this._series = series()
}

util.inherits(Aedes, EE)

function storeRetained(packet, done) {
  if (packet.retain) {
    this.persistence.storeRetained(packet, done)
  } else {
    done()
  }
}

function emitPacket(packet, done) {
  this.mq.emit(packet, done)
}

function enqueueOffline(packet, done) {
  var that      = this
    , parallel  = this._parallel

  if (packet.qos > 0) {
    this.persistence.subscriptionsByTopic(packet.topic, function(err, subs) {
      // TODO handle err
      // TODO remove callback

      doEnqueues(that, packet, subs, done)
    })
  } else {
    done()
  }
}

function doEnqueues(broker, packet, subs, done) {
  if (subs.length === 0) {
    done()
  } else {
    broker._parallel({
        packet: packet
      , broker: broker
    }, doEnqueue, subs, done)
  }
}

function doEnqueue(sub, done) {
  this.broker.persistence.outgoingEnqueue(sub, this.packet, done)
}

var publishFuncs = [
    storeRetained
  , enqueueOffline
  , emitPacket
];
Aedes.prototype.publish = function(packet, done) {
  var p = new Packet(packet, this)
  this._series(this, publishFuncs, p, done)
}

Aedes.prototype.subscribe = function(topic, func, done) {
  var broker = this

  this.mq.on(topic, func, function subscribed() {
    // first do a suback
    done()

    var stream = broker.persistence.createRetainedStream(topic)

    stream.pipe(through.obj(function(packet, enc, cb) {
      func(packet, cb)
    }))

  })
}

Aedes.prototype.unsubscribe = function(topic, func, done) {
  this.mq.removeListener(topic, func, done)
}
