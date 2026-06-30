import write from '../write.js'
import { ReasonCodes } from '../constants.js'

class PubRel {
  constructor (packet) {
    this.cmd = 'pubrel'
    this.messageId = packet.messageId
    // [#822] MQTT 5.0 success reason code (0x00); ignored when serializing v3/v4.
    this.reasonCode = ReasonCodes.SUCCESS
  }
}

function handlePubrec (client, packet, done) {
  const pubrel = new PubRel(packet)

  if (client.clean) {
    write(client, pubrel, done)
    return
  }

  client.broker.persistence.outgoingUpdate(client, pubrel)
    .then(() => write(client, pubrel, done), done)
}

export default handlePubrec
