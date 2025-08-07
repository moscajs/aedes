import { test } from 'node:test'
import { once } from 'node:events'
import {
  checkNoPacket,
  createAndConnect,
  createPubSub,
  nextPacket,
  subscribe,
} from './helper.js'
import { validateTopic } from '../lib/utils.js'

test('validation of `null` topic', (t) => {
  // issue #780
  t.plan(1)
  const err = validateTopic(null, 'SUBSCRIBE')
  t.assert.equal(err.message, 'impossible to SUBSCRIBE to an empty topic')
})

// [MQTT-4.7.1-3]
test('Single-level wildcard should match empty level', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  await subscribe(t, s, 'a/+/b', 0)

  s.inStream.write({
    cmd: 'publish',
    topic: 'a//b',
    payload: 'world'
  })

  const packet = await nextPacket(s)
  t.assert.ok(packet, 'ok')
})

// [MQTT-4.7.3-1]
test('publish empty topic', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  await subscribe(t, s, '#', 0)

  s.inStream.write({
    cmd: 'publish',
    topic: '',
    payload: 'world'
  })

  await checkNoPacket(t, s)
  await new Promise((resolve) => {
    s.broker.close(() => {
      resolve()
    })
  })
  t.assert.equal(s.broker.connectedClients, 0, 'no connected clients')
})

test('publish invalid topic with #', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t)

  await subscribe(t, s, '#', 0)
  s.inStream.write({
    cmd: 'publish',
    topic: 'hello/#',
    payload: 'world'
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, '# is not allowed in PUBLISH', 'raise an error')
  await checkNoPacket(t, s)
})

test('publish invalid topic with +', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t)

  await subscribe(t, s, '+', 0)
  s.inStream.write({
    cmd: 'publish',
    topic: 'hello/+/eee',
    payload: 'world'
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, '+ is not allowed in PUBLISH', 'raise an error')
  await checkNoPacket(t, s)
})

for (const topic of [
  'base/#/sub',
  'base/#sub',
  'base/sub#',
  'base/xyz+/sub',
  'base/+xyz/sub',
  ''
]) {
  test(`subscribe to invalid topic with "${topic}"`, async (t) => {
    t.plan(1)

    const s = await createAndConnect(t)
    s.inStream.write({
      cmd: 'subscribe',
      messageId: 24,
      subscriptions: [{
        topic,
        qos: 0
      }]
    })
    await once(s.broker, 'clientError')
    t.assert.ok(true, 'raise an error')
  })

  test(`unsubscribe to invalid topic with "${topic}"`, async (t) => {
    t.plan(1)

    const s = await createAndConnect(t)

    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 24,
      unsubscriptions: [topic]
    })
    await once(s.broker, 'clientError')
    t.assert.ok(true, 'raise an error')
  })
}

test('topics are case-sensitive', async (t) => {
  t.plan(5)

  const { publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 0)
  for (const topic of ['hello', 'HELLO', 'heLLo', 'HELLO/#', 'hello/+']) {
    publisher.inStream.write({
      cmd: 'publish',
      topic,
      payload: 'world',
      qos: 0,
      retain: false
    })
  }
  const packet = await nextPacket(subscriber)
  // only one packet should be received
  t.assert.deepEqual(structuredClone(packet), expected, 'packet mush match')
  await checkNoPacket(t, subscriber, 10)
})

async function subscribeMultipleTopics (t, publisher, subscriber, qos, subscriptions) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions
  })
  const packet = await nextPacket(subscriber)
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(structuredClone(packet).granted, subscriptions.map(obj => obj.qos))
  t.assert.equal(packet.messageId, 24)

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello/world',
    payload: 'world',
    qos,
    messageId: 42
  })
}

test('Overlapped topics with same QoS', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 20,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  await subscribeMultipleTopics(t, publisher, subscriber, 1, sub)
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 0 publish', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  await subscribeMultipleTopics(t, publisher, subscriber, 0, sub)
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 2 publish', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)

  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  await subscribeMultipleTopics(t, publisher, subscriber, 2, sub)
  await checkNoPacket(t, subscriber, 10)
})

test('Overlapped topics with QoS downgrade', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]

  await subscribeMultipleTopics(t, publisher, subscriber, 0, sub)
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})
