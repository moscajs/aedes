'use strict'

function handlePuback (client, packet, done) {
  var persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client, packet, done)
  client.broker.emit('ack', packet, client)
}

module.exports = handlePuback
