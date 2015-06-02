function Packet (original, broker) {
  this.cmd = original.cmd || 'publish'
  this.brokerId = original.brokerId || (broker && broker.id)
  this.brokerCounter = original.brokerCounter || (broker && (++broker.counter) || 0)
  this.topic = original.topic
  this.payload = original.payload || new Buffer(0)
  this.qos = original.qos || 0
  this.retain = original.retain || false
  this.messageId = 0
}

module.exports = Packet
