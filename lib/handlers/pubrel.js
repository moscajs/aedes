import write from '../write.js'
import { runSeries } from '../utils.js'

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

  const client = this.client
  const persistence = client.broker.persistence
  persistence.incomingDelPacket(client, arg.packet).then(() => {
    // handshake complete: release the slot (see lib/handlers/publish.js). Only
    // on success — if the delete failed the packet is still stored, so freeing
    // the slot would let the store grow past the limit.
    client._inboundInflight.delete(arg.packet.messageId)
    done(null, arg)
  }, () => {
    // a concurrent duplicate PUBREL can lose the race and reject here; PUBCOMP
    // is still owed either way, and the rejection must not escape (it used to
    // ride out of .finally() uncaught and kill the process)
    done(null, arg)
  })
}

function pubrelWrite (arg, done) {
  // Always send PUBCOMP, even if packet was not found in store
  write(this.client, new PubComp(arg.packet), done)
}

export default handlePubrel
