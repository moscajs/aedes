import write from '../write.js'
import { runSeries, ackProperties } from '../utils.js'
import { ReasonCodes } from '../constants.js'

class ClientPacketStatus {
  constructor (client, packet) {
    this.client = client
    this.packet = packet
  }
}

class PubComp {
  constructor (packet, client, foundInStore) {
    this.cmd = 'pubcomp'
    this.messageId = packet.messageId
    // MQTT 5.0 reason code: 0x00 on success, or 0x92 (Packet Identifier not
    // found) when the PUBREL referenced an unknown packet id — with a Reason
    // String [#822/#823], gated by Request Problem Information. Ignored when
    // serializing v3/v4. [MQTT-3.7.2.1]
    if (client.version === 5 && !foundInStore) {
      this.reasonCode = ReasonCodes.PACKET_IDENTIFIER_NOT_FOUND
      const properties = ackProperties(client, 'packet identifier not found')
      if (properties) this.properties = properties
    } else {
      this.reasonCode = ReasonCodes.SUCCESS
    }
  }
}

const pubrelActions = [
  pubrelGet,
  pubrelDelete,
  pubrelWrite
]
function handlePubrel (client, packet, done) {
  runSeries(
    new ClientPacketStatus(client, packet),
    pubrelActions, {}, done)
}

function pubrelGet (arg, done) {
  // MQTT-4.3.3-2: Check if we have this packet in persistence
  const persistence = this.client.broker.persistence
  persistence.incomingGetPacket(this.client, this.packet)
    .then((packet) => {
      arg.packet = this.packet
      arg.foundInStore = !!packet
      done(null, arg)
    }, () => {
      // Even if incomingGetPacket fails, continue to send PUBCOMP
      arg.packet = this.packet
      arg.foundInStore = false
      done(null, arg)
    })
}

function pubrelDelete (arg, done) {
  // Only delete if we found the packet in the store
  if (!arg.foundInStore) {
    return done(null, arg)
  }

  const persistence = this.client.broker.persistence
  persistence.incomingDelPacket(this.client, arg.packet).finally(() => done(null, arg))
}

function pubrelWrite (arg, done) {
  // Always send PUBCOMP, even if packet was not found in store (v5 marks that
  // case with reason code 0x92 rather than 0x00).
  write(this.client, new PubComp(arg.packet, this.client, arg.foundInStore), done)
}

export default handlePubrel
