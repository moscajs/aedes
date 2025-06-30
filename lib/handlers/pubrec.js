'use strict'

const write = require('../write')

class PubRel {
  constructor (packet) {
    this.cmd = 'pubrel'
    this.messageId = packet.messageId
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

module.exports = handlePubrec
