import { test } from 'node:test'
import { once } from 'node:events'
import {
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

test('publish QoS 1', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)
  const expected = {
    cmd: 'puback',
    messageId: 42,
    qos: 0,
    dup: false,
    length: 2,
    retain: false,
    payload: null,
    topic: null
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('publish QoS 1 throws error', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  s.broker.persistence.subscriptionsByTopic = async () => {
    throw new Error('Throws error')
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const [err] = await once(s.broker, 'error')
  t.assert.equal(err.message, 'Throws error', 'Throws error')
})

test('publish QoS 1 throws error on write', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  s.broker.on('client', (client) => {
    client.connected = false
    client.connecting = false

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })
  })

  connect(s, { noWait: true }) // don't wait for connect to complete

  const [client, err] = await once(broker, 'clientError')
  t.assert.ok(client)
  t.assert.equal(err.message, 'connection closed', 'throws error')
})

test('publish QoS 1 and check offline queue', async (t) => {
  t.plan(14)

  const subscriberClient = {
    id: 'abcde'
  }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: false },
    subscriber: { clean: false, clientId: subscriberClient.id }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    retain: false
  }
  const expectedAck = {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 10,
    topic: null,
    payload: null
  }
  const sent = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 10,
    retain: false,
    dup: false
  }
  const queue = []
  await subscribe(t, subscriber, 'hello', 1)
  const puback = await publish(t, publisher, sent)
  t.assert.deepEqual(structuredClone(puback), expectedAck, 'ack packet must match')
  sent.payload = 'world2world'
  await publish(t, publisher, sent)
  for (let i = 0; i < 2; i++) {
    const packet = await nextPacket(subscriber)
    queue.push(packet)
    delete packet.payload
    delete packet.length
    t.assert.ok(packet.messageId, 'messageId is assigned a value')
    t.assert.ok(packet.messageId !== 10, 'messageId should be unique')
    expected.messageId = packet.messageId
    t.assert.deepEqual(structuredClone(packet), expected, 'publish packet must match')
  }

  for (const packet of queue) {
    const origPacket = await broker.persistence.outgoingClearMessageId(subscriberClient, packet)
    if (origPacket) {
      delete origPacket.brokerId
      delete origPacket.brokerCounter
      delete origPacket.payload
      delete origPacket.messageId
      delete sent.payload
      delete sent.messageId
      t.assert.deepEqual(origPacket, sent, 'origPacket must match')
    }
  }
})

test('publish QoS 1 and empty offline queue', async (t) => {
  t.plan(14)

  const subscriberClient = {
    id: 'abcde'
  }

  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: { clean: false },
    subscriber: { clean: false, clientId: subscriberClient.id }
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    retain: false
  }
  const expectedAck = {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 10,
    topic: null,
    payload: null
  }
  const sent = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 10,
    retain: false,
    dup: false
  }
  const queue = []
  await subscribe(t, subscriber, 'hello', 1)
  const puback = await publish(t, publisher, sent)
  t.assert.deepEqual(structuredClone(puback), expectedAck, 'ack packet must match')
  sent.payload = 'world2world'
  await publish(t, publisher, sent)
  for (let i = 0; i < 2; i++) {
    const packet = await nextPacket(subscriber)
    queue.push(packet)
    delete packet.payload
    delete packet.length
    t.assert.ok(packet.messageId, 'messageId is assigned a value')
    t.assert.ok(packet.messageId !== 10, 'messageId should be unique')
    expected.messageId = packet.messageId
    t.assert.deepEqual(structuredClone(packet), expected, 'publish packet must match')
  }
  await new Promise(resolve => {
    broker.clients[subscriberClient.id].emptyOutgoingQueue(resolve)
  })

  for (const packet of queue) {
    const origPacket = await broker.persistence.outgoingClearMessageId(subscriberClient, packet)
    t.assert.equal(!!origPacket, false, 'Packet has been removed')
  }
})

test('subscribe QoS 1', async (t) => {
  t.plan(6)

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
  publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })
  const packet = await nextPacket(subscriber)
  subscriber.inStream.write({
    cmd: 'puback',
    messageId: packet.messageId
  })
  t.assert.ok(packet.messageId !== 42, 'messageId must differ')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('subscribe QoS 0, but publish QoS 1', async (t) => {
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

  publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('restore QoS 1 subscriptions not clean', async (t) => {
  t.plan(7)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

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
  subscriber.inStream.end()
  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')
  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const packet = await nextPacket(subscriber2)
  subscriber2.inStream.write({
    cmd: 'puback',
    messageId: packet.messageId
  })
  t.assert.ok(packet.messageId !== 42, 'messageId must differ')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('restore multiple QoS 1 subscriptions not clean w/ authorizeSubscribe', async (t) => {
  t.plan(11)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

  const expected = {
    cmd: 'publish',
    topic: 'foo',
    payload: Buffer.from('bar'),
    qos: 1,
    dup: false,
    length: 10,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 1)
  await subscribe(t, subscriber, 'foo', 1)
  subscriber.inStream.end()
  broker.authorizeSubscribe = (client, sub, done) => {
    done(null, sub.topic === 'hello' ? 123 : sub)
  }
  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')
  publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })
  publish(t, publisher, {
    cmd: 'publish',
    topic: 'foo',
    payload: 'bar',
    qos: 1,
    messageId: 48
  })

  const packet = await nextPacket(subscriber2)
  subscriber.inStream.write({
    cmd: 'puback',
    messageId: packet.messageId
  })
  t.assert.ok((packet.messageId !== 48), 'messageId must differ')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('remove stored subscriptions if connected with clean=true', async (t) => {
  t.plan(7)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

  await subscribe(t, subscriber, 'hello', 1)
  subscriber.inStream.end()

  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: true, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, false, 'session present is set to false')
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })
  subscriber2.inStream.end()

  const subscriber3 = setup(broker)
  const connack2 = await connect(subscriber3, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack2.sessionPresent, false, 'session present is set to false')
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 43
  })
  await checkNoPacket(t, subscriber2, 10)
  await checkNoPacket(t, subscriber3, 10)
})

test('resend publish on non-clean reconnect QoS 1', async (t) => {
  t.plan(8)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })

  const subscriberClient = {
    id: opts.clientId
  }
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
  subscriber.inStream.end()
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world world',
    qos: 1,
    messageId: 42
  })
  const puback = await nextPacket(publisher)
  t.assert.equal(puback.cmd, 'puback')

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: opts })
  const packet = await nextPacket(subscriber2)
  subscriber2.inStream.write({
    cmd: 'puback',
    messageId: packet.messageId
  })
  t.assert.ok(packet.messageId !== 42, 'messageId must differ')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
  await delay(0) // give aedes the time to process the pubAck
  const stream = broker.persistence.outgoingStream(subscriberClient)
  const list = await stream.toArray()
  t.assert.equal(list.length, 1, 'should remain one item in queue')
  t.assert.deepEqual(list[0].payload, Buffer.from('world world'), 'packet must match')
})

test('resend many publish on non-clean reconnect QoS 1', async (t) => {
  t.plan(5)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })

  const total = publisher.inStream.writableHighWaterMark * 2
  let received = 0

  await subscribe(t, subscriber, 'hello', 1)
  subscriber.inStream.end()

  for (let sent = 0; sent < total; sent++) {
    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'message-' + sent,
      qos: 1,
      messageId: 42 + sent
    })
  }

  await nextPacket(publisher)
  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: opts })
  for await (const packet of subscriber2.outStream) {
    subscriber2.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
    received++
    if (received === total) {
      break
    }
  }
  await checkNoPacket(t, subscriber2, 10) // just make sure there are not more packets
  t.assert.equal(received, total)
})

test('do not resend QoS 1 packets at each reconnect', async (t) => {
  t.plan(7)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })

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
  subscriber.inStream.end()

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: opts })

  const packet = await nextPacket(subscriber2)
  subscriber2.inStream.end({
    cmd: 'puback',
    messageId: packet.messageId
  })

  t.assert.ok(packet.messageId !== 42, 'messageId must differ')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  const subscriber3 = setup(broker)
  await connect(subscriber3, { connect: opts })
  await checkNoPacket(t, subscriber3, 10)
})

test('do not resend QoS 1 packets if reconnect is clean', async (t) => {
  t.plan(5)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

  await subscribe(t, subscriber, 'hello', 1)
  subscriber.inStream.end()

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: { clean: true, clientId: 'abcde' } })
  await checkNoPacket(t, subscriber2, 10)
})

test('do not resend QoS 1 packets at reconnect if puback was received', async (t) => {
  t.plan(6)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

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
  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const packet = await nextPacket(subscriber)
  subscriber.inStream.end({
    cmd: 'puback',
    messageId: packet.messageId
  })

  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  await checkNoPacket(t, subscriber2, 10)
})

test('remove stored subscriptions after unsubscribe', async (t) => {
  t.plan(7)

  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: { clean: false, clientId: 'abcde' }
  })

  await subscribe(t, subscriber, 'hello', 1)
  subscriber.inStream.write({
    cmd: 'unsubscribe',
    messageId: 43,
    unsubscriptions: ['hello']
  })

  const packet = await nextPacket(subscriber)
  t.assert.deepStrictEqual(structuredClone(packet), {
    cmd: 'unsuback',
    messageId: 43,
    dup: false,
    length: 2,
    qos: 0,
    retain: false,
    payload: null,
    topic: null
  }, 'packet matches')

  subscriber.inStream.end()

  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, false, 'session present is set to false')
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 43
  }, () => {
    subscriber.inStream.end()
  })

  await checkNoPacket(t, subscriber, 10)
  await checkNoPacket(t, subscriber2, 10)
})

test('upgrade a QoS 0 subscription to QoS 1', async (t) => {
  t.plan(8)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    length: 14,
    retain: false,
    dup: false
  }

  await subscribe(t, s, 'hello', 0)
  await subscribe(t, s, 'hello', 1)

  s.broker.publish({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1
  })

  const packet = await nextPacket(s)
  t.assert.ok(packet.messageId, 'has messageId')
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('downgrade QoS 0 publish on QoS 1 subsciption', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    length: 12,
    retain: false,
    dup: false
  }

  await subscribe(t, s, 'hello', 1)

  s.broker.publish({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('subscribe and publish QoS 1 in parallel', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  s.broker.on('clientError', (client, err) => {
    console.log(err.stack)
    t.fail('no client error')
  })

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 1
    }]
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  let counter = 0
  for await (const packet of s.outStream) {
    counter++
    if (counter === 1) {
      t.assert.equal(packet.cmd, 'puback')
      t.assert.equal(packet.messageId, 42, 'messageId must match')
    }

    if (packet.cmd === 'suback') {
      t.assert.deepEqual(structuredClone(packet).granted, [1])
      t.assert.equal(packet.messageId, 24)
    }
    if (packet.cmd === 'publish') {
      s.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      delete packet.messageId
      t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
    }
    if (counter === 3) {
      break
    }
  }
})
