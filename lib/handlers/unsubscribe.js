'use strict'

var write = require('../write')

function UnsubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.granted = granted
}

function handleUnsubscribe (client, packet, done) {
  var broker = client.broker

  broker._series(
    new UnsubscribeState(client, packet, done, null),
    doUnsubscribe,
    packet.unsubscriptions,
    completeUnsubscribe)
}

function doUnsubscribe (sub, done) {
  var client = this.client
  var broker = client.broker
  var qos = client.subscriptions[sub]

  delete client.subscriptions[sub]

  broker.unsubscribe(
    sub,
    qos === 1 ? client.deliver1 : client.deliver0,
    done)
}

function completeUnsubscribe (err) {
  var packet = this.packet
  var client = this.client
  var done = this.finish

  if (err) {
    return client.emit('error', err)
  }

  if (packet.messageId) {
    var response = {
      cmd: 'unsuback',
      messageId: packet.messageId
    }

    write(client, response, done)
  } else {
    done()
  }
}

module.exports = handleUnsubscribe
