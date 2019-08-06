'use strict'

var handleConnect = require('./connect')
var handleSubscribe = require('./subscribe')
var handleUnsubscribe = require('./unsubscribe')
var handlePublish = require('./publish')
var handlePuback = require('./puback')
var handlePubrel = require('./pubrel')
var handlePubrec = require('./pubrec')
var handlePing = require('./ping')

function handle (client, packet, done) {
  if (packet.cmd === 'connect') {
    // [MQTT-3.1.0-2]
    return client.connected ? client.conn.destroy() : handleConnect(client, packet, done)
  }
  if (!client.connected) {
    // [MQTT-3.1.0-1]
    return client.conn.destroy()
  }

  if (client._keepaliveInterval > 0) {
    client._keepaliveTimer.reschedule(client._keepaliveInterval)
  }

  switch (packet.cmd) {
    case 'publish':
      handlePublish(client, packet, done)
      break
    case 'subscribe':
      handleSubscribe(client, packet, done)
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
      client.disconnected = true
      client.conn.end()
      break
    default:
      client.conn.destroy()
  }
}

module.exports = handle
