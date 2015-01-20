
var mqemitter   = require('mqemitter')
  , EE          = require('events').EventEmitter
  , Client      = require('./client')
  , util        = require('util')
  , shortid     = require('shortid')

module.exports = Aedes

function Aedes(opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  opts = opts || {}
  opts.concurrency = 10000

  this.id = shortid()
  this.counter = 0
  this.mq = opts.mq || mqemitter(opts)
  this.handle = function(conn) {
    new Client(that, conn)
  }
}

util.inherits(Aedes, EE)

Aedes.prototype.publish = function(packet, done) {
  this.mq.emit(new Packet(packet, this), done)
}

Aedes.prototype.subscribe = function(topic, func, done) {
  this.mq.on(topic, func)
  done() // TODO on should accept a third callback
}

Aedes.prototype.unsubscribe = function(topic, func, done) {
  this.mq.removeListener(topic, func)
  done() // TODO on should accept a third callback
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
