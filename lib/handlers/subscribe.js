'use strict'

var write = require('../write')
var fastfall = require('fastfall')
var Packet = require('aedes-packet')
var through = require('through2')
var topicActions = fastfall([
  authorize,
  storeSubscriptions,
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

function Subscription (qos, func) {
  this.qos = qos
  this.func = func
}

function storeSubscriptions (sub, done) {
  var packet = this.packet
  var client = this.client
  var broker = client.broker
  var perst = broker.persistence

  if (!packet.messageId) {
    // restore subscriptions
    perst._addedSubscriptions(client, [sub])
    return done(null, sub)
  }

  if (packet.subscriptions[0].topic !== sub.topic) {
    // don't call addSubscriptions on each topic
    return done(null, sub)
  }

  perst.addSubscriptions(client, packet.subscriptions, function (err) {
    perst._addedSubscriptions(client, [sub])
    done(err, sub)
  })
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

  this.granted.push(sub.qos)

  if (!client.subscriptions[sub.topic]) {
    client.subscriptions[sub.topic] = new Subscription(sub.qos, func)
    broker.subscribe(sub.topic, func, sendRetained)
  } else if (client.subscriptions[sub.topic].qos !== sub.qos) {
    broker.unsubscribe(sub.topic, client.subscriptions[sub.topic].func)
    client.subscriptions[sub.topic] = new Subscription(sub.qos, func)
    broker.subscribe(sub.topic, func, sendRetained)
  } else {
    sendRetained()
  }

  function sendRetained () {
    // first do a suback
    done()

    var persistence = broker.persistence

    var stream = persistence.createRetainedStream(sub.topic)

    stream.pipe(through.obj(function sendRetained (packet, enc, cb) {
      packet = new Packet(packet)
      // this should not be deduped
      packet.brokerId = null
      client.deliver0(packet, cb)
    }))
  }
}

function completeSubscribe (err) {
  var packet = this.packet
  var client = this.client
  var broker = client.broker
  var granted = this.granted
  var done = this.finish

  if (err) {
    return done(err)
  }

  if (packet.messageId) {
    broker.emit('subscribe', packet.subscriptions, client)
    write(client, new SubAck(packet, granted), done)
  } else {
    done()
  }
}

function SubAck (packet, granted) {
  this.cmd = 'suback'
  this.messageId = packet.messageId
  this.granted = granted
}

function nop () {}

module.exports = handleSubscribe
