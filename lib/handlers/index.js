import handleConnect from './connect.js'
import handleSubscribe from './subscribe.js'
import handleUnsubscribe from './unsubscribe.js'
import handlePublish from './publish.js'
import handlePuback from './puback.js'
import handlePubrel from './pubrel.js'
import handlePubrec from './pubrec.js'
import handlePing from './ping.js'

function handle (client, packet, done) {
  if (packet.cmd === 'connect') {
    if (client.connecting || client.connected) {
      // [MQTT-3.1.0-2]
      finish(client.conn, packet, done)
      return
    }
    handleConnect(client, packet, done)
    return
  }

  if (!client.connecting && !client.connected) {
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
      done()
      return
    default:
      client.conn.destroy()
      done()
      return
  }

  if (client._keepaliveInterval > 0) {
    client._keepaliveTimer.refresh(client._keepaliveInterval)
  }
}

function finish (conn, packet, done) {
  conn.destroy()
  const error = new Error('Invalid protocol')
  error.info = packet
  done(error)
}

export default handle
