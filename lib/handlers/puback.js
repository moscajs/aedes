function handlePuback (client, packet, done) {
  const persistence = client.broker.persistence
  const emitAck = (err, origPacket) => {
    client.broker.emit('ack', origPacket, client)
    done(err)
  }
  persistence.outgoingClearMessageId(client, packet)
    .then((packet) => emitAck(null, packet), emitAck)
}

export default handlePuback
