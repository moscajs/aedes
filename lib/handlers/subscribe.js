'use strict'

const fastfall = require('fastfall')
const Packet = require('aedes-packet')
const { through } = require('../utils')
const { validateTopic } = require('../utils')
const write = require('../write')

const subscribeTopicActions = fastfall([
  authorize,
  storeSubscriptions,
  addSubs
])
const restoreTopicActions = fastfall([
  authorize,
  addSubs
])

function SubAck (packet, granted) {
  this.cmd = 'suback'
  this.messageId = packet.messageId
  // the qos granted
  this.granted = granted
}

function Subscription (qos, func) {
  this.qos = qos
  this.func = func
}

function SubscribeState (client, packet, restore, finish) {
  this.client = client
  this.packet = packet
  this.actions = restore ? restoreTopicActions : subscribeTopicActions
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

function handleSubscribe (client, packet, restore, done) {
  packet.subscriptions = packet.subscriptions.length === 1 ? packet.subscriptions : _dedupe(packet.subscriptions)
  client.broker._parallel(
    new SubscribeState(client, packet, restore, done),
    doSubscribe,
    packet.subscriptions,
    restore ? done : completeSubscribe)
}

function doSubscribe (sub, done) {
  const s = new SubState(this.client, this.packet, sub.qos)
  this.subState.push(s)
  this.actions.call(s, sub, done)
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
    // means failure: MQTT 3.1.1 specs > 3.9.3 Payload
    this.granted = 128
    return done(null, null)
  }

  const packet = this.packet
  const client = this.client

  if (client.clean) {
    return done(null, sub)
  }

  client.broker.persistence.addSubscriptions(client, packet.subscriptions, function addSub (err) {
    done(err, sub)
  })
}

function addSubs (sub, done) {
  if (!sub || typeof sub !== 'object') {
    return done()
  }

  const client = this.client
  const broker = client.broker
  const topic = sub.topic
  const qos = sub.qos
  var func = qos > 0 ? client.deliverQoS : client.deliver0

  // [MQTT-4.7.2-1]
  if (isStartsWithWildcard(topic)) {
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

  if (packet.messageId) {
    // [MQTT-3.9.3-1]
    write(client,
      new SubAck(packet, this.subState.map(obj => obj.granted)),
      done)
  } else {
    done()
  }

  const broker = client.broker
  const subs = packet.subscriptions

  var topics = []

  for (var i = 0; i < subs.length; i++) {
    topics.push(subs[i].topic)
    subs.qos = this.subState[i].granted
  }

  this.subState = []

  broker.emit('subscribe', subs, client)
  broker.publish({
    topic: '$SYS/' + broker.id + '/new/subscribes',
    payload: Buffer.from(JSON.stringify({
      clientId: client.id,
      subs: subs
    }), 'utf8')
  }, noop)

  // Conform to MQTT 3.1.1 section 3.1.2.4
  // Restored sessions should not contain any retained message.
  // Retained message should be only fetched from SUBSCRIBE.

  const persistence = broker.persistence
  const stream = persistence.createRetainedStreamCombi(topics)
  stream.pipe(through(function sendRetained (packet, enc, cb) {
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

function noop () {}

module.exports = handleSubscribe
