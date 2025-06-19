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

  client.broker.persistence.outgoingUpdate(
    client, pubrel, reply)

  function reply (err) {
    if (err) {
      done(err)
    } else {
      write(client, pubrel, done)
    }
  }
}

module.exports = handlePubrec
