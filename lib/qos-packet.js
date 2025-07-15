import Packet from 'aedes-packet'

class QoSPacket extends Packet {
  constructor (original, client) {
    super(original, client.broker)

    this.writeCallback = client._onError.bind(client)

    if (!original.messageId) {
      this.messageId = client._nextId
      if (client._nextId >= 65535) {
        client._nextId = 1
      } else {
        client._nextId++
      }
    } else {
      this.messageId = original.messageId
    }
  }
}

export default QoSPacket
