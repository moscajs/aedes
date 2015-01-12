
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
  opts.concurrency = 1000

  this.mq = opts.mq || mqemitter(opts)
  this.handle = function(conn) {
    new Client(that, conn)
  }
}

util.inherits(Aedes, EE)

Aedes.prototype.publish = function(packet, done) {
  this.mq.emit(packet, done)
}

Aedes.prototype.subscribe = function(packet, func, done) {
  var subs = [].concat(packet.subscriptions)
    , mq   = this.mq

  function subscribe() {
    if (subs.length === 0) return done()

    var sub = subs.shift()
    mq.on(sub.topic, func)
    subscribe() // handle it recursively!
  }

  subscribe()
}
