import handleConnect from './connect.js'
import handleSubscribe from './subscribe.js'
import handleUnsubscribe from './unsubscribe.js'
import handlePublish from './publish.js'
import handlePuback from './puback.js'
import handlePubrel from './pubrel.js'
import handlePubrec from './pubrec.js'
import handlePing from './ping.js'
import { packetWireSize } from '../utils.js'
import { ReasonCodes } from '../constants.js'

function handle (client, packet, done) {
  // MQTT 5.0 Maximum Packet Size: reject a packet larger than the broker
  // allows. A connected v5 client gets a 0x95 (Packet too large) DISCONNECT;
  // a pre-auth or v3/v4 client is dropped with a connectionError/clientError so
  // the rejection is observable. [MQTT-3.2.2-15]
  const maximumPacketSize = client.broker.maximumPacketSize
  if (maximumPacketSize > 0) {
    const wireSize = packetWireSize(packet.length)
    if (wireSize > maximumPacketSize) {
      client.rejectPacketTooLarge(wireSize, done)
      return
    }
  }

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
      // MQTT 5.0: a DISCONNECT may update the Session Expiry Interval (e.g.
      // request a session be retained, or end immediately). [MQTT-3.14.2-2]
      if (client.version === 5 && packet.properties?.sessionExpiryInterval !== undefined) {
        client.sessionExpiryInterval = client.broker.clampSessionExpiry(packet.properties.sessionExpiryInterval)
        // a non-zero interval means the session is now persisted past close
        client.clean = client.sessionExpiryInterval === 0
      }
      // MQTT 5.0: reason code 0x04 (Disconnect with Will Message) requests
      // that the Will Message be published on disconnect. Any other reason
      // code (including the v3/v4 implicit normal disconnect) discards the
      // will. [MQTT-3.14.4-3]
      if (!(client.version === 5 && packet.reasonCode === ReasonCodes.DISCONNECT_WITH_WILL)) {
        client._disconnected = true
      }
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
    client._keepaliveTimer.refresh()
  }
}

function finish (conn, packet, done) {
  conn.destroy()
  const error = new Error('Invalid protocol')
  error.info = packet
  done(error)
}

export default handle
