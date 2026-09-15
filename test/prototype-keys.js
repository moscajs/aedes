import { test } from 'node:test'
import { once } from 'node:events'
import { Aedes } from '../aedes.js'
import {
  checkNoPacket,
  connect,
  createAndConnect,
  nextPacket,
  setup,
  subscribe,
  subscribeMultiple
} from './helper.js'

// GHSA-52qw-whmv-87c5: client.subscriptions, Aedes.clients and the SUBSCRIBE
// dedupe map are keyed by strings that arrive over the wire, so any name
// inherited from Object.prototype used to read back truthy and send the code
// down the "already present" branch on the very first packet.
const PROTOTYPE_NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'toLocaleString',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
]

for (const topic of PROTOTYPE_NAMES) {
  test(`subscribe to prototype-named topic "${topic}"`, async (t) => {
    t.plan(5)

    const s = await createAndConnect(t, { connect: { clientId: 'proto-sub' } })

    await subscribe(t, s, topic, 0)

    s.inStream.write({ cmd: 'publish', topic, payload: 'world' })

    const packet = await nextPacket(s)
    t.assert.equal(packet.topic, topic)
    t.assert.equal(packet.payload.toString(), 'world')
  })

  test(`unsubscribe prototype-named topic "${topic}" that was never subscribed`, async (t) => {
    t.plan(2)

    const s = await createAndConnect(t, { connect: { clientId: 'proto-unsub' } })

    s.inStream.write({ cmd: 'unsubscribe', messageId: 42, unsubscriptions: [topic] })

    const packet = await nextPacket(s)
    t.assert.equal(packet.cmd, 'unsuback')
    t.assert.equal(packet.messageId, 42)
  })

  test(`connect with prototype-named clientId "${topic}"`, async (t) => {
    t.plan(2)

    const s = await createAndConnect(t, { connect: { clientId: topic } })

    t.assert.equal(s.broker.clients[topic], s.client, 'client is registered under its own id')
    t.assert.equal(s.broker.connectedClients, 1)
  })
}

// same topic twice with a different qos takes addSubs' "subscription changed"
// branch, which is where the uncaught AssertionError used to come from
test('re-subscribe to a prototype-named topic with a different qos', async (t) => {
  t.plan(8)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-resub' } })

  await subscribe(t, s, 'constructor', 0, 1)
  await subscribe(t, s, 'constructor', 1, 2)

  s.inStream.write({ cmd: 'publish', topic: 'constructor', payload: 'world', qos: 0 })

  const packet = await nextPacket(s)
  t.assert.equal(packet.topic, 'constructor')
  // if addSubs' "changed" branch skipped broker.unsubscribe, the old listener
  // would still be registered and deliver a second copy
  await checkNoPacket(t, s)
})

// _dedupe built its map with a plain object, so `map['__proto__'] = sub`
// reassigned the prototype instead of adding a key and the subscription vanished
test('prototype-named topic in a multi-subscription SUBSCRIBE survives dedupe', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-dedupe' } })

  await subscribeMultiple(t, s, [
    { topic: '__proto__', qos: 0 },
    { topic: 'plain', qos: 0 }
  ], [0, 0])
})

test('duplicate prototype-named topic in one SUBSCRIBE keeps the last qos', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-dedupe-dup' } })

  await subscribeMultiple(t, s, [
    { topic: 'constructor', qos: 0 },
    { topic: 'constructor', qos: 1 }
  ], [1])
})

// Aedes.clients keyed by clientId: the second connect used to call .close() on
// the inherited value instead of on the previous client [MQTT-3.1.4-2]
test('reconnect with a prototype-named clientId closes the previous client', async (t) => {
  t.plan(6)

  // held in a variable so eslint's no-proto doesn't fire on the lookup
  const clientId = PROTOTYPE_NAMES[0]

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const first = setup(broker)
  await connect(first, { connect: { clientId } })
  t.assert.equal(broker.clients[clientId], first.client)

  // a subscription makes registerClient's close() callback async, which is the
  // ordering the takeover actually runs in
  await subscribe(t, first, 'a/b', 0)

  const takenOver = once(broker, 'client')
  const second = setup(broker)
  await connect(second, { connect: { clientId } })
  await takenOver

  t.assert.equal(broker.clients[clientId], second.client)
  t.assert.equal(first.client.closed, true, 'previous client was closed')
})

// the five stores are null-prototype by hand at five sites; a stray `{}`,
// Object.assign({}, ...) or spread silently reintroduces the crash and only the
// behavioural tests above would catch it, and only on the paths they walk
test('wire-keyed stores have a null prototype', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-invariant' } })

  t.assert.equal(Object.getPrototypeOf(s.broker.clients), null, 'broker.clients')
  t.assert.equal(Object.getPrototypeOf(s.broker.brokers), null, 'broker.brokers')
  t.assert.equal(Object.getPrototypeOf(s.client.subscriptions), null, 'client.subscriptions')
  t.assert.equal(Object.getPrototypeOf(s.client.duplicates), null, 'client.duplicates')
})

// a peer broker announcing a prototype-named client over $SYS hit the same
// registerClient lookup, so in a cluster one such CONNECT killed every peer
test('$SYS new/clients announcing a prototype-named clientId', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-sys' } })

  const announced = 'constructor'

  await new Promise(resolve => {
    s.broker.mq.emit({
      topic: '$SYS/some-other-broker/new/clients',
      payload: Buffer.from(announced, 'utf8')
    }, resolve)
  })

  t.assert.equal(s.broker.clients['proto-sys'], s.client, 'broker survived and kept its clients')
  t.assert.equal(s.broker.clients[announced], undefined, 'no phantom client was registered')
})

// Aedes.brokers is keyed by the heartbeat payload. On a plain object a peer id
// like 'toString' read back truthy, so aedes.js treated that broker as alive and
// aedes-persistence's willsByBrokers suppressed its wills forever — no crash,
// just silently lost will messages
test('prototype-named broker id is not mistaken for a live peer', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-brokers' } })

  t.assert.equal(s.broker.brokers.toString, undefined, 'unheard-of peer is absent')

  await new Promise(resolve => {
    s.broker.mq.emit({ topic: '$SYS/real-peer/heartbeat', payload: Buffer.from('real-peer', 'utf8') }, resolve)
  })

  t.assert.deepEqual(Object.keys(s.broker.brokers), ['real-peer'])
  t.assert.equal(s.broker.brokers.toString, undefined, 'still absent after a real heartbeat')
})

test('unsubscribe a prototype-named topic that was subscribed stops delivery', async (t) => {
  t.plan(7)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-unsub-live' } })

  await subscribe(t, s, 'constructor', 0)

  s.inStream.write({ cmd: 'publish', topic: 'constructor', payload: 'first' })
  const packet = await nextPacket(s)
  t.assert.equal(packet.payload.toString(), 'first')

  s.inStream.write({ cmd: 'unsubscribe', messageId: 43, unsubscriptions: ['constructor'] })
  const unsuback = await nextPacket(s)
  t.assert.equal(unsuback.cmd, 'unsuback')
  t.assert.equal(unsuback.messageId, 43)

  s.inStream.write({ cmd: 'publish', topic: 'constructor', payload: 'second' })
  await checkNoPacket(t, s)
})

// client.duplicates is keyed by packet.brokerId. On a plain object a peer id
// like 'constructor' made dedupe() compare `(<function> || 0) < counter`, which
// is NaN-false, so every packet from that peer was silently dropped
test('prototype-named brokerId does not suppress delivery', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t, { connect: { clientId: 'proto-dup' } })

  await subscribe(t, s, 'a/b', 0)

  await new Promise(resolve => {
    s.broker.mq.emit({
      topic: 'a/b',
      payload: Buffer.from('from-peer', 'utf8'),
      brokerId: 'constructor',
      brokerCounter: 1
    }, resolve)
  })

  const packet = await nextPacket(s)
  t.assert.equal(packet.payload.toString(), 'from-peer')
})
