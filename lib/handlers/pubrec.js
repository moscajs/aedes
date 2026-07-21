import write from '../write.js'
import { ReasonCodes, REASON_CODE_ERROR_THRESHOLD } from '../constants.js'

class PubRel {
  constructor (packet) {
    this.cmd = 'pubrel'
    this.messageId = packet.messageId
    // [#822] MQTT 5.0 success reason code (0x00); ignored when serializing v3/v4.
    this.reasonCode = ReasonCodes.SUCCESS
  }
}

function handlePubrec (client, packet, done) {
  // MQTT 5.0 §4.3.3: a PUBREC whose reason code is >= 0x80 terminates the QoS 2
  // flow — the broker must NOT send a PUBREL. It releases the packet identifier
  // (clearing the stored outgoing state) instead of continuing the handshake.
  if (client.version === 5 && packet.reasonCode >= REASON_CODE_ERROR_THRESHOLD) {
    if (client.clean) {
      return done()
    }
    client.broker.persistence.outgoingClearMessageId(client, packet)
      .then(() => done(), done)
    return
  }

  const pubrel = new PubRel(packet)

  if (client.clean) {
    write(client, pubrel, done)
    return
  }

  client.broker.persistence.outgoingUpdate(client, pubrel)
    .then(() => write(client, pubrel, done), done)
}

export default handlePubrec
