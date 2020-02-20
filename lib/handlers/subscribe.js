'use strict'

const write = require('../write')
const fastfall = require('fastfall')
const Packet = require('aedes-packet')
const through = require('through2')
const Group = require('../group')
const validateTopic = require('./validations').validateTopic
const sharedTopic = require('./validations').sharedTopic

const topicActions = fastfall([
  authorize,
  storeSubscriptions,
  subTopic
])

function SubAck (packet, granted) {
  this.cmd = 'suback'
  this.messageId = packet.messageId
  this.granted = granted
}

function Subscription (qos, func) {
  this.qos = qos
  this.func = func
}

function SubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.subState = []
}

function SubState (client, packet, granted) {
  this.client = client
  this.packet = packet
  this.granted = granted
}

// if same subscribed topic in subs array, we pick up the last one
function _dedupe (subs) {
  var dedupeSubs = {}
  for (var i = 0; i < subs.length; i++) {
    var sub = subs[i]
    dedupeSubs[sub.topic] = sub
  }
  var ret = []
  for (var key in dedupeSubs) {
    ret.push(dedupeSubs[key])
  }
  return ret
}

function handleSubscribe (client, packet, done) {
  const subs = packet.subscriptions
  client.broker._parallel(
    new SubscribeState(client, packet, done),
    doSubscribe,
    subs.length === 1 ? subs : _dedupe(subs),
    completeSubscribe)
}

function doSubscribe (sub, done) {
  const s = new SubState(this.client, this.packet, sub.qos)
  this.subState.push(s)
  topicActions.call(s, sub, done)
}

function authorize (sub, done) {
  const err = validateTopic(sub.topic, 'SUBSCRIBE')
  if (err) {
    return done(err)
  }
  const client = this.client
  client.broker.authorizeSubscribe(client, sub, done)
}

function blockDollarSignTopics (func) {
  return function deliverSharp (packet, cb) {
    // '$' is 36
    if (packet.topic.charCodeAt(0) === 36) {
      cb()
    } else {
      func(packet, cb)
    }
  }
}

function storeSubscriptions (sub, done) {
  if (!sub || typeof sub !== 'object') {
    return done(null, null)
  }

  const packet = this.packet

  if (packet.restore) {
    return done(null, sub)
  }

  const client = this.client

  if (client.clean) {
    return done(null, sub)
  }

  client.broker.persistence.addSubscriptions(client, packet.subscriptions, function addSub (err) {
    done(err, sub)
  })
}

function subTopic (sub, done) {
  if (!sub || typeof sub !== 'object') {
    this.granted = 128
    return done()
  }

  var client = this.client
  const broker = client.broker
  const topic = sub.topic
  const qos = sub.qos
  var func = qos > 0 ? client.deliverQoS : client.deliver0

  if (broker.sharedTopics) {
    const parsedTopic = sharedTopic(sub)
    if (parsedTopic) {
      client = broker.groups[parsedTopic.group] || new Group(parsedTopic.group, broker)
      func = client.deliverMessage
    }
  } else if (isStartsWithWildcard(topic)) { // [MQTT-4.7.2-1]
    func = blockDollarSignTopics(func)
  }

  if (!client.subscriptions[topic]) {
    client.subscriptions[topic] = new Subscription(qos, func)
    broker.subscribe(topic, func, done)
  } else if (client.subscriptions[topic].qos !== qos) {
    broker.unsubscribe(topic, client.subscriptions[topic].func)
    client.subscriptions[topic] = new Subscription(qos, func)
    broker.subscribe(topic, func, done)
  } else {
    done()
  }
}

// + is 43
// # is 35
function isStartsWithWildcard (topic) {
  const code = topic.charCodeAt(0)
  return code === 43 || code === 35
}

function completeSubscribe (err) {
  const done = this.finish

  if (err) {
    return done(err)
  }

  const packet = this.packet
  const client = this.client
  const broker = client.broker
  const granted = this.subState.map(obj => obj.granted)
  this.subState = []

  const subs = packet.subscriptions

  if (!packet.restore) {
    broker.emit('subscribe', subs, client)
  }

  if (packet.messageId) {
    write(client, new SubAck(packet, granted), nop)
  }

  // negated subscription check
  if (granted[0] === 128) {
    return done()
  } else {
    done()
  }

  // Conform to MQTT 3.1.1 section 3.1.2.4
  // Restored sessions should not contain any retained message.
  // Retained message should be only fetched from SUBSCRIBE.
  if (!packet.restore) {
    const persistence = broker.persistence
    var topics = []
    for (var i = 0; i < subs.length; i++) {
      topics.push(subs[i].topic)
    }
    const stream = persistence.createRetainedStreamCombi(topics)
    stream.pipe(through.obj(function sendRetained (packet, enc, cb) {
      packet = new Packet({
        cmd: packet.cmd,
        qos: packet.qos,
        topic: packet.topic,
        payload: packet.payload,
        retain: true
      }, broker)
      // this should not be deduped
      packet.brokerId = null
      client.deliverQoS(packet, cb)
    }))
  }
}

function nop () {}

module.exports = handleSubscribe
