import write from '../write.js'

class ClientPacketStatus {
  constructor (client, packet) {
    this.client = client
    this.packet = packet
  }
}

class PubComp {
  constructor (packet) {
    this.cmd = 'pubcomp'
    this.messageId = packet.messageId
  }
}

const pubrelActions = [
  pubrelGet,
  pubrelPublish,
  pubrelWrite,
  pubrelDel
]
function handlePubrel (client, packet, done) {
  client.broker._series(
    new ClientPacketStatus(client, packet),
    pubrelActions, {}, done)
}

function pubrelGet (arg, done) {
  // Specs: https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html#_Toc398718102
  // Ref: https://github.com/moscajs/aedes/issues/634
  // When the Server receives a PUBREL packet from a Client it MUST respond with a PUBCOMP
  arg.packet = this.packet
  done(null, arg)
}

function pubrelPublish (arg, done) {
  this.client.broker.publish(arg.packet, this.client, done)
}

function pubrelWrite (arg, done) {
  write(this.client, new PubComp(arg.packet), done)
}

function pubrelDel (arg, done) {
  const persistence = this.client.broker.persistence
  persistence.incomingDelPacket(this.client, arg.packet)
    .then(() => done(null), done)
}

export default handlePubrel
