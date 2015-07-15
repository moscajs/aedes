'use strict'

var write = require('../write')

function PubRel (packet) {
  this.cmd = 'pubrel'
  this.messageId = packet.messageId
}

function handlePubrec (client, packet, done) {
  var pubrel = new PubRel(packet)
  client.broker.persistence.outgoingUpdate(
    client, pubrel,
    function (err) {

      if (err) {
        // TODO is this ok?
        return client._onError(err)
      }

      write(client, pubrel, done)
    })
}

module.exports = handlePubrec
