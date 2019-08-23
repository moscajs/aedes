'use strict'

var write = require('../write')

function PubRel (packet) {
  this.cmd = 'pubrel'
  this.messageId = packet.messageId
}

function handlePubrec (client, packet, done) {
  var pubrel = new PubRel(packet)

  if (client.clean) {
    write(client, pubrel, done)
    return
  }

  client.broker.persistence.outgoingUpdate(
    client, pubrel, reply)

  function reply (err) {
    if (err) {
      // TODO is this ok?
      client._onError(err)
      return
    }

    write(client, pubrel, done)
  }
}

module.exports = handlePubrec
