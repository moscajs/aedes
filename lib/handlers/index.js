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
    if (client.connected) {
      // [MQTT-3.1.0-2]
      client.conn.destroy()
      return done(new Error('Invalid protocol'))
    }
    handleConnect(client, packet, done)
    return
  }
  if (!client.connected) {
    // [MQTT-3.1.0-1]
    client.conn.destroy()
    return done(new Error('Invalid protocol'))
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
      // [MQTT-3.14.4-1]
      client.disconnected = true
      client.conn.end()
      return
    default:
      client.conn.destroy()
      return
  }

  if (client._keepaliveInterval > 0) {
    client._keepaliveTimer.reschedule(client._keepaliveInterval)
  }
}

module.exports = handle
