import Packet from 'aedes-packet'
import { through, validateTopic, $SYS_PREFIX, runFall, runParallel, once } from '../utils.js'
import { ReasonCodes } from '../constants.js'
import write from '../write.js'

// [MQTT-3.8.3-1] valid Subscription Identifier range (a Variable Byte Integer).
const SUBSCRIPTION_IDENTIFIER_MAX = 268435455

const subscribeTopicActions = runFall([
  authorize,
  storeSubscriptions,
  addSubs
])
const restoreTopicActions = runFall([
  authorize,
  addSubs
])

class SubAck {
  constructor (packet, granted) {
    this.cmd = 'suback'
    this.messageId = packet.messageId
    // the qos granted
    this.granted = granted
  }
}

class Subscription {
  constructor (qos, func, rh, rap, nl, si) {
    this.qos = qos
    this.func = func

    // MQTT 5.0 Subscription Identifier (if any) echoed on matching publishes
    this.si = si

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
}

class SubscribeState {
  constructor (client, packet, restore, finish) {
    this.client = client
    this.packet = packet
    this.actions = restore ? restoreTopicActions : subscribeTopicActions
    this.finish = finish
    this.subState = []
  }
}

class SubState {
  constructor (client, packet, granted, rh, rap, nl) {
    this.client = client
    this.packet = packet
    this.granted = granted
    this.rh = rh
    this.rap = rap
    this.nl = nl
  }
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

function handleSubscribe (client, packet, restore, finish) {
  const done = once(finish)
  // MQTT 5.0: a SUBSCRIBE-level Subscription Identifier applies to every
  // subscription in the packet. Attach it to each subscription so it is both
  // persisted (for non-clean sessions) and echoed on matching publishes.
  // On the restore path the identifier already travels on each subscription.
  const subscriptionIdentifier = packet.properties?.subscriptionIdentifier
  if (subscriptionIdentifier !== undefined) {
    // [MQTT-3.8.3-1] A Subscription Identifier of 0 (or outside 1..268435455) is
    // a Protocol Error; mqtt-packet decodes the VBI but does not range-check it.
    // Reject the SUBSCRIBE with a 0x82 DISCONNECT. The restore path carries
    // already-validated identifiers, so only live subscribes are checked.
    if (!restore && (subscriptionIdentifier < 1 || subscriptionIdentifier > SUBSCRIPTION_IDENTIFIER_MAX)) {
      client.broker.emit('clientError', client, new Error(`invalid subscription identifier ${subscriptionIdentifier}`))
      client.disconnect({ reasonCode: ReasonCodes.PROTOCOL_ERROR }, () => done())
      return
    }
    for (const sub of packet.subscriptions) {
      sub.subscriptionIdentifier = subscriptionIdentifier
    }
  }
  packet.subscriptions = packet.subscriptions.length === 1 ? packet.subscriptions : _dedupe(packet.subscriptions)
  const state = new SubscribeState(client, packet, restore, done)
  // Use the callback-based runParallel rather than Promise.all(subscriptions.map(...)):
  // SUBSCRIBE is on the control path and runs once per topic, so avoiding the N+1
  // promise allocations per packet keeps allocation flat (matches the original fastparallel).
  runParallel(state, doSubscribe, packet.subscriptions, (err) => {
    if (err) {
      done(err)
    } else if (restore) {
      done()
    } else {
      completeSubscribe.call(state)
    }
  })
}

function doSubscribe (sub, done) {
  const s = new SubState(this.client, this.packet, sub.qos, sub.rh, sub.rap, sub.nl)
  this.subState.push(s)
  // [MQTT-3.2.2-23] / [MQTT-4.8.2] The broker advertises shared subscriptions as
  // unavailable, so a v5 `$share/...` SUBSCRIBE must be refused with 0x9E rather
  // than subscribing to the literal topic (which would be a dead subscription).
  if (this.client.version === 5 && sub.topic.startsWith('$share/')) {
    s.granted = ReasonCodes.SHARED_SUBSCRIPTIONS_NOT_SUPPORTED
    return done()
  }
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

  client.broker.persistence.addSubscriptions(client, packet.subscriptions)
    .then(() => done(null, sub), err => done(err, sub))
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
  // MQTT 5.0 Subscription Identifier travels on the subscription itself (set
  // from the SUBSCRIBE properties on live subscribe, or restored from the
  // persistence layer for non-clean sessions).
  const si = sub.subscriptionIdentifier
  // [MQTT-3.3.4-3] Pre-build the Subscription Identifier property object once
  // per subscription (frozen, so the shared copy can't be mutated) instead of
  // allocating one per delivered message. Only the merge case below allocates.
  // INVARIANT: the delivery path must not mutate `_packet.properties` in place —
  // the forked aedes-packet copies `.properties` by reference into each Packet,
  // so a frozen shared `siProps` (and any other shared properties object) would
  // be corrupted for every fanout subscriber and the source packet.
  const siProps = si !== undefined ? Object.freeze({ subscriptionIdentifier: si }) : null
  let func = qos > 0 ? client.deliverQoS : client.deliver0

  const deliverFunc = func
  func = function handlePacketSubscription (_packet, cb) {
    _packet = new Packet(_packet, broker)
    _packet.nl = nl
    if (!rap) _packet.retain = false
    if (siProps) {
      // Echo the identifier: merge a fresh object only when the packet already
      // carries properties; otherwise reuse the pre-built (frozen) one.
      //
      // KNOWN LIMITATION [MQTT-3.3.4-4]: when a single client has multiple
      // overlapping subscriptions that match one PUBLISH, the spec says the
      // delivered message should carry ALL matching Subscription Identifiers.
      // aedes delivers a single de-duplicated copy, so only one identifier is
      // echoed. Deferred — tracked on the v5 issue (#821 / #828).
      _packet.properties = _packet.properties
        ? { ..._packet.properties, subscriptionIdentifier: si }
        : siProps
    }
    deliverFunc(_packet, cb)
  }

  // [MQTT-4.7.2-1] block $SYS for wildcard subscriptions.
  if (isStartsWithWildcard(topic)) {
    func = blockDollarSignTopics(func)
  }

  if (client.closed || client.broker.closed) {
    // a hack, sometimes client.close() or broker.close() happened
    // before authenticate() comes back
    // we don't continue subscription here
    return
  }

  // Retain Handling 1 needs to know whether this is a brand-new subscription
  // (vs. resubscribe/no-op) to decide whether to send retained messages.
  this.isNewSubscription = !client.subscriptions[topic]
  if (!client.subscriptions[topic]) {
    client.subscriptions[topic] = new Subscription(qos, func, rh, rap, nl, si)
    broker.subscribe(topic, func, done)
  } else if (client.subscriptions[topic].qos !== qos || client.subscriptions[topic].rh !== rh || client.subscriptions[topic].rap !== rap || client.subscriptions[topic].nl !== nl || client.subscriptions[topic].si !== si) {
    const oldFunc = client.subscriptions[topic].func
    client.subscriptions[topic] = new Subscription(qos, func, rh, rap, nl, si)
    broker.unsubscribe(topic, oldFunc)
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

function completeSubscribe () {
  const done = this.finish
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
    const sub = this.subState[i]
    // Only successful subscriptions (a granted QoS 0/1/2) get retained messages;
    // reason codes >= 0x80 (128 failure, 0x9E shared-not-supported, …) do not.
    // [MQTT-3.8.3-2] Retain Handling: rh=2 never sends retained on subscribe;
    // rh=1 only when this is a new subscription; rh=0/undefined always sends.
    if (sub.granted < 0x80 && sub.rh !== 2 && (sub.rh !== 1 || sub.isNewSubscription)) {
      topics.push(subs[i].topic)
    }
    // set granted qos to subscriptions
    subs[i].qos = sub.granted
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
    // [MQTT-3.3.4] A SUBSCRIBE-level Subscription Identifier applies to every
    // subscription in the packet, so it must also be echoed on retained messages
    // delivered on subscribe — which bypass the live-delivery wrapper. (rap/nl
    // don't apply to retained-on-subscribe: the retain flag is always 1, and
    // no-local concerns the subscriber's own publishes, not retained delivery.)
    const retainedSI = this.packet.properties?.subscriptionIdentifier
    const stream = persistence.createRetainedStreamCombi(topics)
    stream.pipe(through(function sendRetained (packet, enc, cb) {
      // MQTT 5.0 Message Expiry Interval for retained messages: drop (and
      // remove) a retained message that has expired; otherwise deliver it with
      // the remaining lifetime and preserve its v5 properties.
      const now = Date.now()
      if (packet.messageExpiry !== undefined) {
        const remainingMs = packet.messageExpiry - now
        if (remainingMs <= 0) {
          persistence.storeRetained({ topic: packet.topic, payload: Buffer.alloc(0) })
            .then(() => cb(), () => cb())
          return
        }
      }
      const newPacket = new Packet({
        cmd: packet.cmd,
        qos: packet.qos,
        topic: packet.topic,
        payload: packet.payload,
        retain: true
      }, broker)
      if (packet.properties !== undefined || packet.messageExpiry !== undefined || retainedSI !== undefined) {
        newPacket.properties = { ...packet.properties }
        if (packet.messageExpiry !== undefined) {
          newPacket.properties.messageExpiryInterval = Math.ceil((packet.messageExpiry - now) / 1000)
        }
        if (retainedSI !== undefined) {
          newPacket.properties.subscriptionIdentifier = retainedSI
        }
      }
      // this should not be deduped
      newPacket.brokerId = null
      client.deliverQoS(newPacket, cb)
    }))
  }
}

function noop () { }

export default handleSubscribe
