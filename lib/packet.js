
function Packet(original, broker) {
  this.cmd      = 'publish'
  this.id       = original.id || broker.id + '-' + (++broker.counter)
  this.topic    = original.topic
  this.payload  = original.payload || new Buffer(0)
  this.qos      = original.qos || 0
  this.retain   = original.retain || false
}

module.exports = Packet
