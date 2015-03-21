
var mqemitter   = require('mqemitter')
  , EE          = require('events').EventEmitter
  , Client      = require('./lib/client')
  , util        = require('util')
  , memory      = require('./lib/persistence')
  , through     = require('through2')
  , shortid     = require('shortid')

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
}

util.inherits(Aedes, EE)

function storeRetained(broker, packet, done) {
  broker.persistence.store(packet, function() {
    broker.mq.emit(new Packet(packet, broker), done)
  })
}

Aedes.prototype.publish = function(packet, done) {
  if (packet.retain) {
    storeRetained(this, packet, done)
  } else {
    this.mq.emit(new Packet(packet, this), done)
  }
}

Aedes.prototype.subscribe = function(topic, func, done) {
  var broker = this

  this.mq.on(topic, func, function subscribed() {
    // first do a suback
    done()

    var stream = broker.persistence.createRetainedStream(topic)

    stream.pipe(through.obj(function(packet, enc, cb) {
      func(packet, done)
      cb()
    }))

  })
}

Aedes.prototype.unsubscribe = function(topic, func, done) {
  this.mq.removeListener(topic, func, done)
}

function Packet(original, broker) {
  broker.counter++
  this.cmd      = 'publish'
  this.id       = broker.id + '-' + broker.counter
  this.topic    = original.topic
  this.payload  = original.payload || new Buffer(0)
  this.qos      = original.qos || 0
  this.retain   = original.retain || false
}
