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
  const client = this.client
  const packet = this.packet
  const persistence = client.broker.persistence
  persistence.incomingGetPacket(client, packet)
    .then((storedPacket) => reply(null, storedPacket), reply)

  function reply (err, storedPacket) {
    if (err) {
      // If packet is not found, log warning and continue to send PUBCOMP
      // This handles the case where a client retries PUBREL after the broker
      // already completed the QoS 2 flow (MQTT-4.3.3-2)
      client.broker.emit('warning', err, client)
      arg.packet = packet
      arg.skipPublish = true
      arg.skipDelete = true
      done(null)
    } else {
      arg.packet = storedPacket
      done(null)
    }
  }
}

function pubrelPublish (arg, done) {
  if (arg.skipPublish) {
    done(null)
  } else {
    this.client.broker.publish(arg.packet, this.client, done)
  }
}

function pubrelWrite (arg, done) {
  write(this.client, new PubComp(arg.packet), done)
}

function pubrelDel (arg, done) {
  if (arg.skipDelete) {
    done(null)
  } else {
    const persistence = this.client.broker.persistence
    persistence.incomingDelPacket(this.client, arg.packet)
      .then(() => done(null), done)
  }
}

export default handlePubrel
