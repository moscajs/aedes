import { test } from 'node:test'
import { once } from 'node:events'
import {
  checkNoPacket,
  connect,
  createAndConnect,
  createPubSub,
  nextPacket,
  nextPacketWithTimeOut,
  publish,
  setup,
  subscribe,
} from './helper.js'
import { Aedes } from '../aedes.js'
import handle from '../lib/handlers/pubrec.js'

async function receive (t, subscriber, expected) {
  const packet = await nextPacket(subscriber)
  t.assert.ok(packet.messageId !== expected.messageId, 'messageId must differ')
  const msgId = packet.messageId
  delete packet.messageId
  delete expected.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  subscriber.inStream.write({
    cmd: 'pubrec',
    messageId: msgId
  })

  const pubRel = await nextPacket(subscriber)
  t.assert.deepStrictEqual(structuredClone(pubRel), {
    cmd: 'pubrel',
    messageId: msgId,
    length: 2,
    qos: 1,
    retain: false,
    dup: false,
    payload: null,
    topic: null
  }, 'pubrel must match')

  subscriber.inStream.write({
    cmd: 'pubcomp',
    messageId: msgId
  })
}

test('publish QoS 2', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }
  await publish(t, s, packet)
})

test('subscribe QoS 2', async (t) => {
  t.plan(8)

  const { publisher, subscriber } = await createPubSub(t)
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 2)
  await publish(t, publisher, toPublish)
  await receive(t, subscriber, toPublish)
})

test('publish QoS 2 throws error on write', async (t) => {
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
      qos: 2,
      messageId: 42
    })
  })

  connect(s, { noWait: true }) // don't wait for connect to complete

  const [client, err] = await once(broker, 'clientError')
  t.assert.ok(client)
  t.assert.equal(err.message, 'connection closed', 'throws error')
})

test('pubrec handler calls done when outgoingUpdate fails (clean=false)', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  s.broker.persistence.outgoingUpdate = async () => {
    throw Error('throws error')
  }

  await new Promise((resolve) => {
    handle(s.client, { messageId: 42 }, function done () {
      t.assert.ok(true, 'calls done on error')
      resolve()
    })
  })
})

test('client.publish with clean=true subscribption QoS 2', async (t) => {
  t.plan(8)

  const s = await createAndConnect(t, { connect: { clean: true } })
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  s.client.on('error', err => {
    t.assert.ok(!err)
  })

  await subscribe(t, s, 'hello', 2)
  t.assert.ok(true, 'subscribed')

  await new Promise((resolve) => {
    s.client.publish(toPublish, err => {
      t.assert.ok(!err)
      resolve()
    })
  })
  await receive(t, s, toPublish)
})

test('call published method with client with QoS 2', async (t) => {
  t.plan(9)

  const { broker, publisher, subscriber } = await createPubSub(t)
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  broker.published = (packet, client, cb) => {
    // Client is null for all server publishes
    if (packet.topic.split('/')[0] !== '$SYS') {
      t.assert.ok(client, 'client must be passed to published method')
      cb()
    }
  }

  await subscribe(t, subscriber, 'hello', 2)
  await publish(t, publisher, toPublish)
  await receive(t, subscriber, toPublish)
})

for (const cleanSession of [true, false]) {
  test(`authorized forward publish packets in QoS 2 [clean=${cleanSession}]`, async (t) => {
    t.plan(9)

    const { broker, publisher, subscriber } = await createPubSub(t, {
      publisher: { clientId: 'my-client-xyz-8' },
      subscriber: { clean: cleanSession, clientId: 'abcde' }
    })

    const forwarded = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      dup: false,
      messageId: undefined,
      clientId: 'my-client-xyz-8'
    }
    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      length: 14,
      dup: false
    }
    broker.authorizeForward = (client, packet) => {
      forwarded.brokerId = broker.id
      forwarded.brokerCounter = broker.counter
      delete packet.nl
      t.assert.deepEqual(structuredClone(packet), forwarded, 'forwarded packet must match')
      return packet
    }

    await subscribe(t, subscriber, 'hello', 2)

    await publish(t, publisher, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      messageId: 42,
      dup: false
    })

    const packet = await nextPacket(subscriber)
    t.assert.ok(packet.messageId !== 42, 'messageId must differ')
    delete packet.messageId
    t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

    const stream = broker.persistence.outgoingStream({ id: 'abcde' })
    const list = await stream.toArray()
    if (cleanSession) {
      t.assert.equal(list.length, 0, 'should have empty item in queue')
    } else {
      t.assert.equal(list.length, 1, 'should have one item in queue')
    }
  })
}

for (const cleanSession of [true, false]) {
  test(`unauthorized forward publish packets in QoS 2 [clean=${cleanSession}]`, async (t) => {
    t.plan(7)

    const { broker, publisher, subscriber } = await createPubSub(t, {
      publisher: { clientId: 'my-client-xyz-8' },
      subscriber: { clean: cleanSession, clientId: 'abcde' }
    })

    broker.authorizeForward = (client, packet) => { }

    await subscribe(t, subscriber, 'hello', 2)
    await publish(t, publisher, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      messageId: 42,
      dup: false
    })
    await checkNoPacket(t, subscriber, 10)

    const stream = broker.persistence.outgoingStream({ id: 'abcde' })
    const list = await stream.toArray()
    t.assert.equal(list.length, 0, 'should empty in queue')
  })
}

test('subscribe QoS 0, but publish QoS 2', async (t) => {
  t.plan(6)

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

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    retain: false,
    messageId: 42,
    dup: false
  })

  const packet = await nextPacket(subscriber)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('subscribe QoS 1, but publish QoS 2', async (t) => {
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

  await publish(t, publisher, {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    retain: false,
    messageId: 42,
    dup: false
  })

  const packet = await nextPacket(subscriber)
  delete packet.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('restore QoS 2 subscriptions not clean', async (t) => {
  t.plan(9)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 2)
  subscriber.inStream.end()

  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: opts })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')
  // getting a connack does not mean that the client setup has completed in Aedes
  await once(broker, 'clientReady')
  await publish(t, publisher, expected)
  await receive(t, subscriber2, expected)
})

test('resend publish on non-clean reconnect QoS 2', async (t) => {
  t.plan(8)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 2)
  subscriber.inStream.end()

  await publish(t, publisher, expected)
  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: opts })
  await receive(t, subscriber2, expected)
})

test('resend pubrel on non-clean reconnect QoS 2', async (t) => {
  t.plan(9)

  const opts = { clean: false, clientId: 'abcde' }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    subscriber: opts
  })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 2)
  subscriber.inStream.end()

  await publish(t, publisher, expected)

  const subscriber2 = setup(broker)
  await connect(subscriber2, { connect: opts })

  const packet = await nextPacket(subscriber2)
  t.assert.ok(packet.messageId !== expected.messageId, 'messageId must differ')
  const msgId = packet.messageId
  delete packet.messageId
  delete expected.messageId
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')

  subscriber2.inStream.write({
    cmd: 'pubrec',
    messageId: msgId
  })

  const pubRel = await nextPacket(subscriber2)
  t.assert.deepEqual(structuredClone(pubRel), {
    cmd: 'pubrel',
    messageId: msgId,
    length: 2,
    qos: 1,
    retain: false,
    dup: false,
    payload: null,
    topic: null
  }, 'pubrel must match')

  subscriber2.inStream.end()
  const subscriber3 = setup(broker)
  await connect(subscriber3, { connect: opts })

  const pubRel2 = await nextPacket(subscriber3)
  t.assert.deepEqual(structuredClone(pubRel2), {
    cmd: 'pubrel',
    messageId: msgId,
    length: 2,
    qos: 1,
    retain: false,
    dup: false,
    payload: null,
    topic: null
  }, 'pubrel must match')

  subscriber3.inStream.write({
    cmd: 'pubcomp',
    messageId: msgId
  })
})

// GHSA-p8r9-qf8w-p73r: a QoS 2 messageId left in the inbound dedup store by an
// incomplete handshake must not survive a clean-session reconnect [MQTT-3.1.2-6]
test('do not dedup a reused QoS 2 messageId after clean reconnect', async (t) => {
  t.plan(13)

  const opts = { clientId: 'abcde', clean: true }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: opts
  })
  const toPublish = () => ({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    retain: false,
    messageId: 7
  })

  await subscribe(t, subscriber, 'hello', 2)

  // publish, take the PUBREC but never send the PUBREL
  publisher.inStream.write(toPublish())
  const pubrec = await nextPacket(publisher)
  t.assert.equal(pubrec.cmd, 'pubrec', 'pubrec must be received')
  t.assert.equal(pubrec.messageId, 7, 'pubrec messageId must match')
  await receive(t, subscriber, toPublish())

  publisher.inStream.end()

  const publisher2 = setup(broker)
  await connect(publisher2, { connect: opts })
  publisher2.inStream.write(toPublish())
  const pubrec2 = await nextPacket(publisher2)
  t.assert.equal(pubrec2.cmd, 'pubrec', 'pubrec must be received')
  t.assert.equal(pubrec2.messageId, 7, 'pubrec messageId must match')

  // bounded so a swallowed message fails as an assertion instead of hanging
  const delivered = await nextPacketWithTimeOut(subscriber, 2000)
  t.assert.ok(delivered, 'subscriber must receive the republished message')
  t.assert.equal(delivered?.topic, 'hello', 'delivered topic must match')
  t.assert.deepEqual(delivered?.payload, Buffer.from('world'), 'delivered payload must match')
})

// Guards the pre-existing [MQTT-4.3.3-2] behaviour. Note it cannot exercise the
// clean-session fix: cleanIncoming only runs on the clean path, so the two are
// mutually exclusive by construction.
test('dedup a reused QoS 2 messageId after non-clean reconnect', async (t) => {
  t.plan(11)

  const opts = { clientId: 'abcde', clean: false }
  const { broker, publisher, subscriber } = await createPubSub(t, {
    publisher: opts
  })
  const toPublish = () => ({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    retain: false,
    messageId: 7
  })

  await subscribe(t, subscriber, 'hello', 2)

  publisher.inStream.write(toPublish())
  const pubrec = await nextPacket(publisher)
  t.assert.equal(pubrec.cmd, 'pubrec', 'pubrec must be received')
  t.assert.equal(pubrec.messageId, 7, 'pubrec messageId must match')
  await receive(t, subscriber, toPublish())

  publisher.inStream.end()

  const publisher2 = setup(broker)
  await connect(publisher2, { connect: opts })
  publisher2.inStream.write(toPublish())
  const pubrec2 = await nextPacket(publisher2)
  t.assert.equal(pubrec2.cmd, 'pubrec', 'pubrec must be received')
  t.assert.equal(pubrec2.messageId, 7, 'pubrec messageId must match')
  // [MQTT-4.3.3-2] the session survived, so the retransmission must not be republished
  // generous bound: a regression here means a packet DOES arrive, and 10ms is
  // easy to lose on a loaded CI runner
  await checkNoPacket(t, subscriber, 2000)
})

// this test does the same as it did before conversion from Tap
// but it does not seem to do what the title says
test('publish after disconnection', async (t) => {
  t.plan(10)

  const { publisher, subscriber } = await createPubSub(t)
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }
  const toPublish2 = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('worl2'),
    qos: 2,
    messageId: 43,
    dup: false,
    length: 14,
    retain: false
  }

  await subscribe(t, subscriber, 'hello', 2)
  await publish(t, publisher, toPublish)
  await receive(t, subscriber, toPublish)
  await publish(t, publisher, toPublish2)
})

test('multiple publish and store one', async (t) => {
  t.plan(1)

  const sid = {
    id: 'abcde'
  }
  const s = await createAndConnect(t, { connect: { clientId: sid.id } })

  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    retain: false,
    dup: false,
    messageId: 42
  }

  let count = 5
  while (count--) {
    s.inStream.write(toPublish)
    await nextPacket(s)
  }

  // read before close(): a clean session's incoming store is discarded with the
  // connection [MQTT-3.1.2-6], so this must happen while the session is alive
  const origPacket = await s.broker.persistence.incomingGetPacket(sid, toPublish)
  delete origPacket.brokerId
  delete origPacket.brokerCounter
  t.assert.deepEqual(origPacket, toPublish, 'packet must match')

  await new Promise((resolve) => {
    s.broker.close(resolve)
  })
})

test('packet is written to stream after being stored', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)
  const persistence = s.broker.persistence

  t.mock.method(persistence, 'incomingStorePacket')

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }

  await publish(t, s, packet)
  t.assert.equal(persistence.incomingStorePacket.mock.callCount(), 1, 'after packet store')
})

test('not send pubrec when persistence fails to store packet', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  s.broker.persistence.incomingStorePacket = async () => {
    t.assert.ok(true, 'packet stored')
    throw new Error('store error')
  }

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }

  s.inStream.write(packet)
  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client, 'client exists')
  t.assert.equal(err.message, 'store error')
})

test('send pubcomp when receiving pubrel even if incomingDelPacket throws (no packet in store)', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  // Mock incomingDelPacket to throw an error (simulating no packet in store)
  s.broker.persistence.incomingDelPacket = async () => {
    throw new Error('packet not found in store')
  }

  // Send a PUBREL packet directly
  const pubrelPacket = {
    cmd: 'pubrel',
    messageId: 42,
    dup: false,
  }

  s.inStream.write(pubrelPacket)

  // Should receive a PUBCOMP response despite the error in incomingDelPacket
  const pubcompPacket = await nextPacket(s)
  t.assert.equal(pubcompPacket.cmd, 'pubcomp', 'should send pubcomp')
  t.assert.equal(pubcompPacket.messageId, 42, 'messageId should match')
})

test('publish QoS 2 returns error when broker.publish fails', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  const broker = s.broker
  const originalPublish = broker.publish.bind(broker)

  broker.publish = function (packet, client, done) {
    if (packet.topic === 'hello' && packet.qos === 2) {
      setImmediate(() => done(new Error('boom')))
      return
    }
    return originalPublish(packet, client, done)
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  })

  const [client, err] = await once(broker, 'clientError')
  t.assert.ok(client)
  t.assert.equal(err.message, 'boom')
})

// GHSA-p8r9 regression guard: a persistence that predates cleanIncoming must
// not break the clean-session CONNECT, however it fails to provide the method
test('clean-session connect survives a persistence without cleanIncoming', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  // a pre-v11 persistence simply doesn't have the method
  broker.persistence.cleanIncoming = undefined

  const s = setup(broker)
  const connack = await connect(s, { connect: { clientId: 'no-clean-incoming', clean: true } })

  t.assert.equal(connack.cmd, 'connack')
  t.assert.equal(connack.returnCode, 0)
})

// [MQTT-3.1.2-6]: a clean session ends with the connection, so its dedup store
// must not wait for a reconnect that may never come
test('clean session discards its QoS 2 dedup store on disconnect', async (t) => {
  t.plan(2)

  const clientId = 'vanishing'
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const s = setup(broker)
  await connect(s, { connect: { clientId, clean: true } })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 7
  })
  const pubrec = await nextPacket(s)
  t.assert.equal(pubrec.cmd, 'pubrec')

  // disconnect without ever sending PUBREL
  const gone = once(broker, 'clientDisconnect')
  s.inStream.write({ cmd: 'disconnect' })
  await gone

  await t.assert.rejects(
    broker.persistence.incomingGetPacket({ id: clientId }, { messageId: 7 }),
    'the dedup entry is gone with the session'
  )
})
