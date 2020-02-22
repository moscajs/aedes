'use strict'

const Packet = require('aedes-packet')
const util = require('util')
const { noop } = require('./utils')

function QoSPacket (original, client) {
  Packet.call(this, original, client.broker)

  this.writeCallback = noop

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

util.inherits(QoSPacket, Packet)

module.exports = QoSPacket
