'use strict'

const write = require('../write')

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
  const persistence = this.client.broker.persistence
  persistence.incomingGetPacket(this.client, this.packet)
    .then((packet) => reply(null, packet), reply)

  function reply (err, packet) {
    arg.packet = packet
    done(err)
  }
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

module.exports = handlePubrel
