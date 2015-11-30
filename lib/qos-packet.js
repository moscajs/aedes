'use strict'

var Packet = require('aedes-packet')
var util = require('util')

function QoSPacket (original, client) {
  Packet.call(this, original, client.broker)

  this.writeCallback = nop

  if (!original.messageId) {
    this.messageId = client._nextId
    if (client._nextId === 65535) {
      client._nextId = 0
    } else {
      client._nextId++
    }
  } else {
    this.messageId = original.messageId
  }
}

util.inherits(QoSPacket, Packet)

function nop () {}

module.exports = QoSPacket
