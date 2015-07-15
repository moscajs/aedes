'use strict'

var write = require('../write')

function SubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.granted = granted
}

function handleSubscribe (client, packet, done) {
  var broker = client.broker
  var subs = packet.subscriptions
  var i
  var length = subs.length
  var granted = []

  for (i = 0; i < length; i++) {
    granted.push(subs[i].qos)
  }

  broker._series(
    new SubscribeState(client, packet, done, granted),
    doSubscribe,
    subs,
    completeSubscribe)
}

function doSubscribe (sub, done) {
  var client = this.client
  var broker = client.broker
  var func = nop

  switch (sub.qos) {
    case 2:
      func = client.deliver2
      break
    case 1:
      func = client.deliver1
      break
    default:
      func = client.deliver0
      break
  }

  client.subscriptions[sub.topic] = sub.qos

  broker.subscribe(sub.topic, func, done)
}

function completeSubscribe (err) {
  var client = this.client
  var broker = client.broker
  var done = this.finish

  if (err) {
    return client.emit('error', err)
  }

  broker._series(this, [storeSubscriptions, doSuback], null, done || nop)
}

function storeSubscriptions (arg, done) {
  var packet = this.packet
  var client = this.client
  var broker = client.broker
  var perst = broker.persistence

  perst.addSubscriptions(client, packet.subscriptions, done)
}

function SubAck (packet, granted) {
  this.cmd = 'suback'
  this.messageId = packet.messageId
  this.granted = granted
}

function doSuback (arg, done) {
  var packet = this.packet
  var client = this.client
  var granted = this.granted

  if (packet.messageId) {
    write(client, new SubAck(packet, granted), done)
  } else {
    done()
  }
}

function nop () {}

module.exports = handleSubscribe
