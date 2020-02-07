'use strict'

const handleConnect = require('./connect')
const handleSubscribe = require('./subscribe')
const handleUnsubscribe = require('./unsubscribe')
const handlePublish = require('./publish')
const handlePuback = require('./puback')
const handlePubrel = require('./pubrel')
const handlePubrec = require('./pubrec')
const handlePing = require('./ping')

function handle (client, packet, done) {
  if (packet.cmd === 'connect') {
    if (client.connected || !client._connectTimer) {
      // [MQTT-3.1.0-2]
      finish(client.conn, packet, done)
      return
    }
    handleConnect(client, packet, done)
    return
  }
  if (!client.connected) {
    // [MQTT-3.1.0-1]
    finish(client.conn, packet, done)
    return
  }

  switch (packet.cmd) {
    case 'publish':
      handlePublish(client, packet, done)
      break
    case 'subscribe':
      handleSubscribe(client, packet, false, done)
      break
    case 'unsubscribe':
      handleUnsubscribe(client, packet, done)
      break
    case 'pubcomp':
    case 'puback':
      handlePuback(client, packet, done)
      break
    case 'pubrel':
      handlePubrel(client, packet, done)
      break
    case 'pubrec':
      handlePubrec(client, packet, done)
      break
    case 'pingreq':
      handlePing(client, packet, done)
      break
    case 'disconnect':
      // [MQTT-3.14.4-3]
      client._disconnected = true
      // [MQTT-3.14.4-1] [MQTT-3.14.4-2]
      client.conn.destroy()
      return
    default:
      client.conn.destroy()
      return
  }

  if (client._keepaliveInterval > 0) {
    client._keepaliveTimer.reschedule(client._keepaliveInterval)
  }
}

function finish (conn, packet, done) {
  conn.destroy()
  var error = new Error('Invalid protocol')
  error.info = packet
  done(error)
}

module.exports = handle
