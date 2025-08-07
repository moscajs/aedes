import { test } from 'node:test'
import { once } from 'node:events'
import {
  brokerPublish,
  checkNoPacket,
  connect,
  createAndConnect,
  createPubSub,
  delay,
  nextPacket,
  publish,
  setup,
  subscribe,
} from './helper.js'
import { Aedes } from '../aedes.js'

// [MQTT-3.3.1-9]
test('live retain packets', async (t) => {
  t.plan(5)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    retain: false,
    dup: false,
    length: 12,
    qos: 0
  }

  const s = await createAndConnect(t)

  await subscribe(t, s, 'hello', 0)

  await brokerPublish(s, {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    retain: true,
    dup: false,
    length: 12,
    qos: 0
  })
  t.assert.ok(true, 'publish finished')
  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected)
})

test('retain messages', async (t) => {
  t.plan(4)

  const { broker, publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  const doSubscribe = async () => {
    await new Promise((resolve) => {
      broker.subscribe('hello', (packet, cb) => {
        cb()
        resolve()
      })
    })
    await subscribe(t, subscriber, 'hello', 0)
  }

  // run parallel
  await Promise.all([
    doSubscribe(),
    publisher.inStream.write(expected)
  ])

  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('retain messages propagates through broker subscriptions', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    retain: true
  }

  await new Promise((resolve) => {
    const subscriberFunc = (packet, cb) => {
      packet = Object.assign({}, packet)
      delete packet.brokerId
      delete packet.brokerCounter
      cb()
      setImmediate(() => {
        t.assert.deepEqual(structuredClone(packet), expected, 'packet must not have been modified')
        resolve()
      })
    }

    broker.subscribe('hello', subscriberFunc, () => {
      broker.publish(expected)
    })
  })
})

test('avoid wrong deduping of retain messages', async (t) => {
  t.plan(8)

  const { broker, publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  const doSubscribe = async () => {
    await new Promise((resolve) => {
      broker.subscribe('hello', (packet, cb) => {
        cb()
        resolve()
      })
    })
    // subscribe and publish another topic
    await subscribe(t, subscriber, 'hello2', 0, 10)
    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello2',
      payload: Buffer.from('world'),
      qos: 0,
      dup: false
    })
    // receive publish and verify topic
    const packet = await nextPacket(subscriber)
    t.assert.deepEqual(packet.topic, 'hello2', 'packet must match')
  }
  // run parallel
  await Promise.all([
    doSubscribe(),
    publisher.inStream.write(expected)
  ])

  // get the retained message
  await subscribe(t, subscriber, 'hello', 0)
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('reconnected subscriber will not receive retained messages when QoS 0 and clean', async (t) => {
  t.plan(5)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: true },
    subscriber: { clean: true }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false,
    length: 12
  }

  await subscribe(t, subscriber, 'hello', 0)
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: false
  })
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
  subscriber.inStream.end()
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'foo',
    qos: 0,
    retain: true
  })
  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: { clean: true } })
  await checkNoPacket(t, subscriber2, 10)
})

test('subscriber will not receive retained messages when QoS is 128', async (t) => {
  t.plan(5)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: true },
    subscriber: { clean: true }
  })

  const pubPacket = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    retain: true,
    messageId: 42
  }

  broker.authorizeSubscribe = (client, sub, callback) => {
    if (sub.topic === pubPacket.topic) {
      callback(null, null)
    } else {
      callback(null, sub)
    }
  }

  await publish(t, publisher, pubPacket)
  await subscribe(t, subscriber, pubPacket.topic, 128)
  await checkNoPacket(t, subscriber, 10)
})

// [MQTT-3.3.1-6]
test('new QoS 0 subscribers receive QoS 0 retained messages when clean', async (t) => {
  t.plan(9)

  const { broker, publisher, subscriber: subscriber1 } = await createPubSub(t, {
    publisher: { clean: true },
    subscriber: { clean: true }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('big big world'),
    qos: 0,
    retain: true,
    dup: false,
    length: 26
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello/world',
    payload: 'big big world',
    qos: 0,
    retain: true
  })

  await subscribe(t, subscriber1, 'hello/world', 0)
  const packet1 = await nextPacket(subscriber1)
  t.assert.deepEqual(structuredClone(packet1), expected, 'packet must match')

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: { clean: true } })
  await subscribe(t, subscriber2, 'hello/+', 0)
  const packet2 = await nextPacket(subscriber2)
  t.assert.deepEqual(structuredClone(packet2), expected, 'packet must match')
  t.assert.equal(broker.counter, 9)
})

// [MQTT-3.3.1-5]
test('new QoS 0 subscribers receive downgraded QoS 1 retained messages when clean', async (t) => {
  t.plan(7)

  const publisher = await createAndConnect(t, {
    connect: { clean: true },
  })
  const broker = publisher.broker

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: true,
    dup: false,
    length: 12
  }
  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    retain: true,
    messageId: 42
  })

  const subscriber = setup(broker)
  await connect(subscriber, { connect: { clean: true } })
  await subscribe(t, subscriber, 'hello', 0)
  const packet = await nextPacket(subscriber)
  t.assert.ok(packet.messageId !== 42, 'messageId should not be the same')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
  broker.close()

  await once(broker, 'closed')
  t.assert.equal(broker.counter, 9)
})

// [MQTT-3.3.1-10]
test('clean retained messages', async (t) => {
  t.plan(4)

  const publisher = await createAndConnect(t, {
    connect: { clean: true },
  })
  const broker = publisher.broker

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    qos: 0,
    retain: true
  })
  const subscriber = setup(broker)
  await connect(subscriber, { connect: { clean: true } })
  await subscribe(t, subscriber, 'hello', 0)
  await checkNoPacket(t, subscriber, 10)
})

// [MQTT-3.3.1-11]
test('broker not store zero-byte retained messages', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    retain: true
  })

  await new Promise(resolve => {
    s.broker.on('publish', async (packet, client) => {
      if (packet.topic.startsWith('$SYS/')) {
        return
      }
      const stream = s.broker.persistence.createRetainedStream(packet.topic)
      const result = await stream.toArray()
      if (result?.[0] === undefined) {
        t.assert.ok(true, 'no zero-byte retained messages stored')
      } else {
        t.assert.fail('zero-byte retained messages should not be stored')
      }
      resolve()
    })
  })
})

test('fail to clean retained messages without retain flag', async (t) => {
  t.plan(4)

  const publisher = await createAndConnect(t, {
    connect: { clean: true },
  })
  const broker = publisher.broker
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: true,
    dup: false,
    length: 12
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    qos: 0,
    retain: false
  })
  const subscriber = setup(broker)
  await connect(subscriber, { connect: { clean: true } })
  await subscribe(t, subscriber, 'hello', 0)
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('only get the last retained messages in same topic', async (t) => {
  t.plan(4)

  const publisher = await createAndConnect(t, {
    connect: { clean: true },
  })
  const broker = publisher.broker
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('foo'),
    qos: 0,
    retain: true,
    dup: false,
    length: 10
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'foo',
    qos: 0,
    retain: true
  })
  const subscriber = setup(broker)
  await connect(subscriber, { connect: { clean: true } })
  await subscribe(t, subscriber, 'hello', 0)
  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('deliver QoS 1 retained messages to new subscriptions', async (t) => {
  t.plan(5)

  const { publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: true },
    subscriber: { clean: true }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: true
  }

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42,
    retain: true
  })

  await delay(10) // give Aedes some time to process the publish
  await subscribe(t, subscriber, 'hello', 1)
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('deliver QoS 1 retained messages to established subscriptions', async (t) => {
  t.plan(4)

  const { publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 1)

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42,
    retain: true
  })
  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('deliver QoS 0 retained message with QoS 1 subscription', async (t) => {
  t.plan(4)

  const { broker, publisher, subscriber } = await createPubSub(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  const checkOnBroker = async () => {
    await new Promise(resolve => {
      broker.mq.on('hello', (msg, cb) => {
        cb()
        // defer this or it will receive the message which
        // is being published
        resolve()
      })
    })
    await subscribe(t, subscriber, 'hello', 1)
    const packet = await nextPacket(subscriber)
    t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
  }

  const doPublish = () => {
    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0,
      messageId: 42,
      retain: true
    })
  }
  // run parallel
  await Promise.all([
    checkOnBroker(),
    doPublish()
  ])
})

test('disconnect and retain messages with QoS 1 [clean=false]', async (t) => {
  t.plan(8)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: false },
    subscriber: { clean: false, clientId: 'abcde' }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: true
  }

  await subscribe(t, subscriber, 'hello', 1)
  subscriber.inStream.write({
    cmd: 'disconnect'
  })

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42,
    retain: true
  })

  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')

  const packet = await nextPacket(subscriber2)
  // receive any queued messages (no matter they are retained messages) at the disconnected time
  t.assert.ok(packet.messageId !== 42, 'messageId must differ')
  delete packet.messageId
  packet.length = 14
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
  // expect no more packets
  await checkNoPacket(t, subscriber2, 10)
})

test('disconnect and two retain messages with QoS 1 [clean=false]', async (t) => {
  t.plan(15)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    length: 14,
    retain: true
  }

  await subscribe(t, subscriber, 'hello', 1)
  await delay(10)
  subscriber.inStream.write({
    cmd: 'disconnect'
  })

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 41,
    retain: true
  })

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world2',
    qos: 1,
    messageId: 42,
    retain: true
  })

  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')

  const packet = await nextPacket(subscriber2)
  // receive any queued messages (included retained messages) at the disconnected time
  t.assert.ok(packet.messageId !== 41, 'messageId must differ')
  delete packet.messageId
  packet.length = 14
  expected.payload = Buffer.from('world')
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  // receive any queued messages (included retained messages) at the disconnected time
  const packet2 = await nextPacket(subscriber2)
  t.assert.ok(packet2.messageId !== 42, 'messageId must differ')
  delete packet2.messageId
  packet2.length = 14
  expected.payload = Buffer.from('world2')
  t.assert.deepEqual(structuredClone(packet2), expected, 'packet must match')

  // should get the last retained message when we do a subscribe
  await subscribe(t, subscriber2, 'hello', 1)
  const packet3 = await nextPacket(subscriber2)
  t.assert.ok(packet3.messageId !== 42, 'messageId must differ')
  delete packet3.messageId
  packet3.length = 14
  expected.payload = Buffer.from('world2')
  t.assert.deepEqual(structuredClone(packet3), expected, 'packet must match')
})
