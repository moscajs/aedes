'use strict'

var write = require('../write')

function PubAck (packet) {
  this.cmd = 'puback'
  this.messageId = packet.messageId
}

function PubRec (packet) {
  this.cmd = 'pubrec'
  this.messageId = packet.messageId
}

function handlePublish (client, packet, done) {
  switch (packet.qos) {
    case 2:
      write(client, new PubRec(packet))
      client.broker.persistence.incomingStorePacket(client, packet, done)
      break
    case 1:
      write(client, new PubAck(packet))
      client.broker.publish(packet, done)
      break
    case 0:
      client.broker.publish(packet, done)
      break
    default:
      // nothing to do
  }
}

module.exports = handlePublish
