'use strict'

function handlePuback (client, packet, done) {
  var persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client, packet, done)
}

module.exports = handlePuback
