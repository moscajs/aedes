'use strict'

function handlePuback (client, packet, done) {
  const persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client, packet, function (err, origPacket) {
    client.broker.emit('ack', origPacket, client)
    done(err)
  })
}

module.exports = handlePuback
