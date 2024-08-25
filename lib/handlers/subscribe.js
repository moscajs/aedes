'use strict'

const fastfall = require('fastfall')
const Packet = require('aedes-packet')
const { through } = require('../utils')
const { validateTopic, $SYS_PREFIX } = require('../utils')
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

function Subscription (qos, func, rh, rap, nl) {
  this.qos = qos
  this.func = func

  // retain-handling indicates how retained messages should be
  // handled when a new subscription is created
  // (see [MQTT-3.3.1-9] through [MQTT-3.3.1-11])
  this.rh = rh

  // retain-as-published indicates whether to leave the retain flag as-is (true)
  // or to clear it before sending to subscriptions (false) default false
  // (see [MQTT-3.3.1-12] through [MQTT-3.3.1-13])
  this.rap = rap

  // no-local indicates that a client should not receive its own
  // messages (see [MQTT-3.8.3-3])
  this.nl = nl
}

function SubscribeState (client, packet, restore, finish) {
  this.client = client
  this.packet = packet
  this.actions = restore ? restoreTopicActions : subscribeTopicActions
  this.finish = finish
  this.subState = []
}

function SubState (client, packet, granted, rh, rap, nl) {
  this.client = client
  this.packet = packet
  this.granted = granted
  this.rh = rh
  this.rap = rap
  this.nl = nl
}

// if same subscribed topic in subs array, we pick up the last one
function _dedupe (subs) {
  const dedupeSubs = {}
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]
    dedupeSubs[sub.topic] = sub
  }
  const ret = []
  for (const key in dedupeSubs) {
    ret.push(dedupeSubs[key])
  }
  return ret
}

function handleSubscribe (client, packet, restore, done) {
  packet.subscriptions = packet.subscriptions.length === 1 ? packet.subscriptions : _dedupe(packet.subscriptions)
  client.broker._parallel(
    new SubscribeState(client, packet, restore, done), // what will be this in the functions
    doSubscribe, // function to call
    packet.subscriptions, // first argument of the function
    restore ? done : completeSubscribe // the function to be called when the parallel ends
  )
}

function doSubscribe (sub, done) {
  const s = new SubState(this.client, this.packet, sub.qos, sub.rh, sub.rap, sub.nl)
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
  const rh = this.rh
  const rap = this.rap
  const nl = this.nl
  let func = qos > 0 ? client.deliverQoS : client.deliver0

  const deliverFunc = func
  func = function handlePacketSubscription (_packet, cb) {
    _packet = new Packet(_packet, broker)
    _packet.nl = nl
    if (!rap) _packet.retain = false
    deliverFunc(_packet, cb)
  }

  // [MQTT-4.7.2-1]
  if (isStartsWithWildcard(topic)) {
    func = blockDollarSignTopics(func)
  }

  if (client.closed || client.broker.closed) {
    // a hack, sometimes client.close() or broker.close() happened
    // before authenticate() comes back
    // we don't continue subscription here
    return
  }

  if (!client.subscriptions[topic]) {
    client.subscriptions[topic] = new Subscription(qos, func, rh, rap, nl)
    broker.subscribe(topic, func, done)
  } else if (client.subscriptions[topic].qos !== qos || client.subscriptions[topic].rh !== rh || client.subscriptions[topic].rap !== rap || client.subscriptions[topic].nl !== nl) {
    broker.unsubscribe(topic, client.subscriptions[topic].func)
    client.subscriptions[topic] = new Subscription(qos, func, rh, rap, nl)
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

  if (packet.messageId !== undefined) {
    // [MQTT-3.9.3-1]
    write(client,
      new SubAck(packet, this.subState.map(obj => obj.granted)),
      done)
  } else {
    done()
  }

  const broker = client.broker

  // subscriptions array to return as result in 'subscribe' event and $SYS
  const subs = packet.subscriptions

  // topics we need to retrieve retain values from
  const topics = []

  for (let i = 0; i < subs.length; i++) {
    // skip topics that are not allowed
    if (this.subState[i].granted !== 128) {
      topics.push(subs[i].topic)
    }
    // set granted qos to subscriptions
    subs[i].qos = this.subState[i].granted
  }

  this.subState = []

  broker.emit('subscribe', subs, client)
  broker.publish({
    topic: $SYS_PREFIX + broker.id + '/new/subscribes',
    payload: Buffer.from(JSON.stringify({
      clientId: client.id,
      subs
    }), 'utf8')
  }, noop)

  // Conform to MQTT 3.1.1 section 3.1.2.4
  // Restored sessions should not contain any retained message.
  // Retained message should be only fetched from SUBSCRIBE.

  if (topics.length > 0) {
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
}

function noop () { }

module.exports = handleSubscribe
