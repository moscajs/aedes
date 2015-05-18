function Packet (original, broker) {
  this.cmd = 'publish'
  this.brokerId = original.brokerId || broker.id
  this.brokerCounter = original.brokerCounter || (++broker.counter)
  this.topic = original.topic
  this.payload = original.payload || new Buffer(0)
  this.qos = original.qos || 0
  this.retain = original.retain || false
  this.messageId = 0
}

module.exports = Packet
