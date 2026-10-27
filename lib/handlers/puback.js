function handlePuback (client, packet, done) {
  const persistence = client.broker.persistence
  // The client acknowledged an outbound QoS>0 message (PUBACK for QoS 1,
  // PUBCOMP for QoS 2); its Packet Identifier is no longer in flight and may be
  // reused safely.
  client._outgoingInFlight.delete(packet.messageId)
  const emitAck = (err, origPacket) => {
    client.broker.emit('ack', origPacket, client)
    done(err)
  }
  persistence.outgoingClearMessageId(client, packet)
    .then((packet) => emitAck(null, packet), emitAck)
}

export default handlePuback
