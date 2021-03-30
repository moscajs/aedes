'use strict'

const Packet = require('aedes-packet')
const util = require('util')

function QoSPacket (original, client) {
  Packet.call(this, original, client.broker)

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

  this.setDupIfNecessary = (persistence, client, cb) => {
    if (this.qos === 2) {
      persistence.outgoingUpdate(client, { ...this, dup: true }, cb)
    } else {
      cb()
    }
  }
}

util.inherits(QoSPacket, Packet)

module.exports = QoSPacket
