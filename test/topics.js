import { test } from 'node:test'
import { once } from 'node:events'
import {
  checkNoPacket,
  createAndConnect,
  createPubSub,
  delay,
  nextPacket,
  subscribe,
} from './helper.js'
import { topicLevelCount, validateTopic } from '../lib/utils.js'

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

async function subscribeMultipleAndPublish (t, publisher, subscriber, qos, subscriptions) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions
  })
  const packet = await nextPacket(subscriber)
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(structuredClone(packet).granted, subscriptions.map(obj => obj.qos))
  t.assert.equal(packet.messageId, 24)

  const pubPacket = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: 'world',
    qos,
    messageId: 42
  }

  publisher.inStream.write(pubPacket)

  return pubPacket
}

test('Overlapped topics with same QoS', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  const { messageId, ...pubPacket } = await subscribeMultipleAndPublish(t, publisher, subscriber, 1, sub)
  const expected = {
    ...pubPacket,
    payload: Buffer.from(pubPacket.payload),
    qos: 1,
    dup: false,
    length: 20,
    retain: false
  }
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

// [MQTT-3.3.5-1]
// FIXME: The broker currently delivers at first subscription's QoS (0), not max QoS (2)
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 0 publish', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  const { messageId, ...pubPacket } = await subscribeMultipleAndPublish(t, publisher, subscriber, 0, sub)
  const expected = {
    ...pubPacket,
    payload: Buffer.from(pubPacket.payload),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

// [MQTT-3.3.5-1]
// FIXME: The broker currently delivers at first subscription's QoS (0), not max QoS (2)
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 2 publish', async (t) => {
  t.plan(8)

  const { publisher, subscriber } = await createPubSub(t)
  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  const { messageId, ...pubPacket } = await subscribeMultipleAndPublish(t, publisher, subscriber, 2, sub)

  // Broker currently delivers at first subscription's QoS (0), not max QoS (2)
  const expected = {
    ...pubPacket,
    payload: Buffer.from(pubPacket.payload),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }

  // After the publisher sends PUBLISH with QoS 2, it should receive PUBREC
  const pubrec = await nextPacket(publisher)
  t.assert.equal(pubrec.cmd, 'pubrec', 'should receive pubrec')
  t.assert.equal(pubrec.messageId, messageId, 'messageId should match')

  // Subscriber receives the message immediately (new behavior)
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  // Complete the QoS 2 handshake on publisher side
  publisher.inStream.write({
    cmd: 'pubrel',
    messageId
  })

  // Should receive PUBCOMP
  const pubcomp = await nextPacket(publisher)
  t.assert.equal(pubcomp.cmd, 'pubcomp', 'should receive pubcomp')
  t.assert.equal(pubcomp.messageId, messageId, 'messageId should match')
})

test('Overlapped topics with QoS downgrade', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]

  const { messageId, ...pubPacket } = await subscribeMultipleAndPublish(t, publisher, subscriber, 0, sub)
  const expected = {
    ...pubPacket,
    payload: Buffer.from(pubPacket.payload),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

// GHSA-xxqp-5qx8-gj5q: a remote client could crash the broker by sending a
// PUBLISH/SUBSCRIBE/UNSUBSCRIBE (or setting a Will) with a deeply nested topic.
// qlobber (used by mqemitter and the persistence trie) throws a synchronous
// `too many words` error past its max_words limit, which propagated as an
// uncaught exception. The broker now rejects topics above `maxTopicLevels`.
const tooManyLevels = 'a/'.repeat(200) + 'b' // 201 levels, default limit is 100

test('topicLevelCount counts levels like qlobber splits them', (t) => {
  t.plan(4)
  t.assert.equal(topicLevelCount(''), 1)
  t.assert.equal(topicLevelCount('a'), 1)
  t.assert.equal(topicLevelCount('a/b/c'), 3)
  t.assert.equal(topicLevelCount('a//b'), 3)
})

test('publish to a topic with too many levels raises an error', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: tooManyLevels,
    payload: 'world'
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, 'topic has too many levels', 'raise an error')
  await checkNoPacket(t, s)
})

test('subscribe to a topic with too many levels raises an error', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{ topic: tooManyLevels, qos: 0 }]
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, 'topic has too many levels', 'raise an error')
})

test('broker.unsubscribe with too many levels errors instead of crashing', async (t) => {
  // A client can never be subscribed to an over-limit topic (subscribe rejects
  // it first), so the handler never forwards one here. This guards the public
  // broker.unsubscribe() API, whose mqemitter.removeListener would otherwise
  // throw `too many words` asynchronously and crash the process.
  t.plan(1)

  const s = await createAndConnect(t)
  await new Promise((resolve) => {
    s.broker.unsubscribe(tooManyLevels, () => {}, (err) => {
      t.assert.equal(err.message, 'topic has too many levels', 'raise an error')
      resolve()
    })
  })
})

test('a Will with too many levels does not crash the broker', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, {
    connect: {
      will: {
        topic: tooManyLevels,
        payload: Buffer.from('bye'),
        qos: 0,
        retain: false
      }
    }
  })
  // ungraceful disconnect triggers the Will publish
  s.conn.destroy()
  await delay(100)
  // if the broker had crashed the process would have thrown; reaching here is the assertion
  t.assert.equal(s.broker.connectedClients, 0, 'broker survived the malicious Will')
})

test('maxTopicLevels is configurable and bounds the depth', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t, { broker: { maxTopicLevels: 3 } })

  // within the limit: delivered normally
  await subscribe(t, s, 'a/b/c', 0)
  s.inStream.write({ cmd: 'publish', topic: 'a/b/c', payload: 'world' })
  const packet = await nextPacket(s)
  t.assert.equal(packet.topic, 'a/b/c', 'topic at the limit is delivered')

  // above the limit: rejected
  s.inStream.write({ cmd: 'publish', topic: 'a/b/c/d', payload: 'world' })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'topic above the limit is rejected')
})

test('topic at the level limit is accepted, one above is rejected', async (t) => {
  t.plan(4)

  const atLimit = 'a/'.repeat(99) + 'a' // 100 levels
  const overLimit = 'a/'.repeat(100) + 'a' // 101 levels
  const s = await createAndConnect(t)

  await subscribe(t, s, atLimit, 0) // exactly at the limit: accepted (suback)

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 25,
    subscriptions: [{ topic: overLimit, qos: 0 }]
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'one level above the limit is rejected')
})

test('maxTopicLevels is clamped to a maximum of 100', async (t) => {
  // configuring above the qlobber ceiling must not be honored: a 101-level
  // topic is still rejected (not routed into qlobber, which would crash).
  t.plan(1)

  const s = await createAndConnect(t, { broker: { maxTopicLevels: 1000 } })
  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{ topic: 'a/'.repeat(100) + 'a', qos: 0 }] // 101 levels
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'clamped to 100, rejected not crashed')
})

test('maxTopicLevels of 0 is clamped to 1 (cannot be disabled)', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, { broker: { maxTopicLevels: 0 } })
  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{ topic: 'a/b', qos: 0 }] // 2 levels, over the clamped limit of 1
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'guard cannot be disabled')
})

test('over-limit SUBSCRIBE on a persistent session is rejected before persistence', async (t) => {
  // non-clean session runs persistence.addSubscriptions before broker.subscribe;
  // the boundary check must reject first, with the consistent broker error
  // (not qlobber's raw "too many words") and without persisting anything.
  t.plan(1)

  const s = await createAndConnect(t, { connect: { clean: false, clientId: 'persist-deep' } })
  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{ topic: tooManyLevels, qos: 1 }]
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'rejected at the boundary')
})

test('over-limit QoS 1 PUBLISH is rejected without sending PUBACK', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: tooManyLevels,
    payload: 'world',
    qos: 1,
    messageId: 42
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'raise an error')
  await checkNoPacket(t, s) // rejected before the PUBACK is written
})

test('over-limit QoS 2 PUBLISH is rejected without sending PUBREC', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: tooManyLevels,
    payload: 'world',
    qos: 2,
    messageId: 43
  })
  const [, err] = await once(s.broker, 'clientError')
  t.assert.equal(err.message, 'topic has too many levels', 'raise an error')
  await checkNoPacket(t, s) // rejected before the PUBREC is written
})
