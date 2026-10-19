import Packet from 'aedes-packet'

// Largest MQTT Packet Identifier (2-byte unsigned). 0 is reserved.
const MAX_PACKET_ID = 65535

// Allocate the next outbound Packet Identifier that is not currently in flight
// for this client. The per-client counter wraps from MAX_PACKET_ID back to 1;
// without this guard a client that stops acknowledging (a slow or malicious
// subscriber) would exhaust the space and cause the broker to reuse an
// identifier still awaiting acknowledgment, breaking the QoS>0
// PUBLISH<->PUBACK correspondence (see GHSA-4f66-hmm8-75r2). Returns null when
// the entire 16-bit space is in flight, in which case the caller should drop
// the connection rather than reuse an in-flight identifier.
function allocateOutgoingId (client) {
  const inFlight = client._outgoingInFlight
  let id = client._nextId
  for (let i = 0; i < MAX_PACKET_ID; i++) {
    if (!inFlight.has(id)) {
      client._nextId = (id >= MAX_PACKET_ID) ? 1 : id + 1
      inFlight.add(id)
      return id
    }
    id = (id >= MAX_PACKET_ID) ? 1 : id + 1
  }
  return null
}

class QoSPacket extends Packet {
  constructor (original, client) {
    super(original, client.broker)

    this.writeCallback = client._onError.bind(client)

    if (!original.messageId) {
      const id = allocateOutgoingId(client)
      if (id === null) {
        throw new Error('outgoing Packet Identifier space exhausted: client has too many unacknowledged QoS>0 messages')
      }
      this.messageId = id
    } else {
      this.messageId = original.messageId
    }
  }
}

export default QoSPacket
