'use strict'

const write = require('../write')

class PubAck {
  constructor (packet) {
    this.cmd = 'puback'
    this.messageId = packet.messageId
  }
}

class PubRec {
  constructor (packet) {
    this.cmd = 'pubrec'
    this.messageId = packet.messageId
  }
}

const publishActions = [
  authorizePublish,
  enqueuePublish
]
function handlePublish (client, packet, done) {
  const topic = packet.topic
  let err
  if (topic.length === 0) {
    err = new Error('empty topic not allowed in PUBLISH')
    return done(err)
  }
  if (topic.indexOf('#') > -1) {
    err = new Error('# is not allowed in PUBLISH')
    return done(err)
  }
  if (topic.indexOf('+') > -1) {
    err = new Error('+ is not allowed in PUBLISH')
    return done(err)
  }
  client.broker._series(client, publishActions, packet, done)
}

function enqueuePublish (packet, done) {
  const client = this

  switch (packet.qos) {
    case 2:
      client.broker.persistence.incomingStorePacket(client, packet)
        .then(() => write(client, new PubRec(packet), done), done)
      break
    case 1:
      write(client, new PubAck(packet), function (err) {
        if (err) { return done(err) }
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
