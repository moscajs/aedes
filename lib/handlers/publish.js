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
  var topic = packet.topic
  var err
  if (topic.length === 0) {
    err = new Error('empty topic not allowed in PUBLISH')
    return done(err)
  }
  for (var i = 0; i < topic.length; i++) {
    switch (topic.charCodeAt(i)) {
      case 35:
        err = new Error('# is not allowed in PUBLISH')
        return done(err)
      case 43:
        err = new Error('+ is not allowed in PUBLISH')
        return done(err)
    }
  }
  client.broker._series(client, publishActions, packet, done)
}

function enqueuePublish (packet, done) {
  var client = this

  switch (packet.qos) {
    case 2:
      write(client, new PubRec(packet), function () {
        client.broker.persistence.incomingStorePacket(client, packet, done)
      })
      break
    case 1:
      write(client, new PubAck(packet), function () {
        client.broker.publish(packet, client, done)
      })
      break
    case 0:
      client.broker.publish(packet, client, done)
      break
    default:
      // nothing to do
  }
}

function authorizePublish (packet, done) {
  this.broker.authorizePublish(this, packet, done)
}

module.exports = handlePublish
