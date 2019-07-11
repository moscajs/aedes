'use strict'

function handlePuback (client, packet, done) {
  if (client.clean) {
    client.broker.emit('ack', packet, client)
    done()
    return
  }

  var persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client, packet, function (err, origPacket) {
    client.broker.emit('ack', origPacket, client)
    done(err)
  })
}

module.exports = handlePuback
