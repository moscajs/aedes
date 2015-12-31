'use strict'

var write = require('../write')
var fastfall = require('fastfall')
var Packet = require('aedes-packet')
var through = require('through2')
var topicActions = fastfall([
  authorize,
  subTopic
])

function SubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.granted = granted
}

function handleSubscribe (client, packet, done) {
  var broker = client.broker
  var subs = packet.subscriptions
  var granted = []

  broker._series(
    new SubscribeState(client, packet, done, granted),
    doSubscribe,
    subs,
    completeSubscribe)
}

function doSubscribe (sub, done) {
  // TODO this function should not be needed
  topicActions.call(this, sub, done)
}

function authorize (sub, done) {
  var client = this.client
  client.broker.authorizeSubscribe(client, sub, done)
}

function blockSys (func) {
  return function deliverSharp (packet, cb) {
    if (packet.topic.indexOf('$SYS') === 0) {
      cb()
    } else {
      func(packet, cb)
    }
  }
}

function subTopic (sub, done) {
  if (!sub) {
    this.granted.push(128)
    return done()
  }

  var client = this.client
  var broker = client.broker
  var func = nop

  switch (sub.qos) {
    case 2:
    case 1:
      func = client.deliverQoS
      break
    default:
      func = client.deliver0
      break
  }

  if (sub.topic === '#') {
    func = blockSys(func)
  }

  client.subscriptions[sub.topic] = sub.qos
  this.granted.push(sub.qos)

  broker.subscribe(sub.topic, func, sendRetained)

  function sendRetained () {
    // first do a suback
    done()

    var persistence = broker.persistence

    var stream = persistence.createRetainedStream(sub.topic)

    stream.pipe(through.obj(function sendRetained (packet, enc, cb) {
      if (packet.qos > sub.qos) {
        packet = new Packet(packet)
        packet.qos = sub.qos
      }

      if (packet.qos > 0) {
        persistence.outgoingEnqueue({
          clientId: client.id,
          topic: sub.topic,
          qos: sub.qos
        }, packet, function () {
          func(packet, cb)
        })
      } else {
        client.deliver0(packet, cb)
      }
    }))
  }
}

var completeSubscribeActions = [
  storeSubscriptions,
  doSuback
]
function completeSubscribe (err) {
  var client = this.client
  var broker = client.broker
  var done = this.finish

  if (err) {
    return done(err)
  }

  broker._series(this, completeSubscribeActions, null, done || nop)
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

  client.broker.emit('subscribe', packet.subscriptions, client)

  if (packet.messageId) {
    write(client, new SubAck(packet, granted), done)
  } else {
    done()
  }
}

function nop () {}

module.exports = handleSubscribe
