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

var publishActions = [
  authorizePublish,
  enqueuePublish
]
function handlePublish (client, packet, done) {
  client.broker._series(client, publishActions, packet, done)
}

function enqueuePublish (packet, done) {
  var client = this

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

function authorizePublish (packet, done) {
  this.broker.authorizePublish(this, packet, done)
}

module.exports = handlePublish
