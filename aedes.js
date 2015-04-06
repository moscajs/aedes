
var mqemitter   = require('mqemitter')
  , EE          = require('events').EventEmitter
  , Client      = require('./lib/client')
  , util        = require('util')
  , memory      = require('./lib/persistence')
  , through     = require('through2')
  , parallel    = require('fastparallel')
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
}

util.inherits(Aedes, EE)

function storeRetained(packet, done) {
  this.persistence.storeRetained(packet, done)
}

function emitPacket(packet, done) {
  this.mq.emit(packet, done)
}

Aedes.prototype.publish = function(packet, done) {
  var p = new Packet(packet, this)
  if (packet.retain) {
    this._parallel(this, [
      storeRetained,
      emitPacket
    ], p, done)
  } else {
    this.mq.emit(p, done)
  }
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
