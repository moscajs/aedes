
var from2   = require('from2')
  , Qlobber = require('qlobber').Qlobber

function MemoryPersistence() {
  if (!(this instanceof MemoryPersistence)) {
    return new MemoryPersistence()
  }

  this._retained = []
}

MemoryPersistence.prototype.store = function(packet, cb) {
  this._retained.push(packet)
  setImmediate(cb)
  return this
}

MemoryPersistence.prototype.createRetainedStream = function(pattern) {
  var current = [].concat(this._retained)
    , matcher = new Qlobber()

  matcher.add(pattern, true)

  return from2.obj(function(size, next) {
    var packet

    while (packet = current.shift()) {
      if (matcher.match(packet.topic).length > 0) {
        next(null, packet)
        return
      }
    }

    if (!packet)
      this.push(null)
  })
}

MemoryPersistence.prototype.destroy = function(cb) {
  this._retained = null
  if (cb) {
    setImmediate(cb)
  }
}

module.exports = MemoryPersistence
