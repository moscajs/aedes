
var mqemitter       = require('mqemitter')
  , EE              = require('events').EventEmitter
  , Client          = require('./client')
  , util            = require('util')

module.exports = Aedes

function Aedes(opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  opts = opts || {}
  opts.concurrency = 10000

  this.mq = opts.mq || mqemitter(opts)
  this.handle = function(conn) {
    new Client(that, conn)
  }
}

util.inherits(Aedes, EE)

Aedes.prototype.publish = function(packet, done) {
  this.mq.emit(packet, done)
}

Aedes.prototype.subscribe = function(topic, func, done) {
  this.mq.on(topic, func)
  done() // TODO on should accept a third callback
}

Aedes.prototype.unsubscribe = function(topic, func, done) {
  this.mq.removeListener(topic, func)
  done() // TODO on should accept a third callback
}
