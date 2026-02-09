import { test } from 'node:test'
import { once } from 'node:events'
import {
  checkNoPacket,
  connect,
  createAndConnect,
  createPubSub,
  nextPacket,
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

  await new Promise((resolve) => {
    s.broker.close(resolve)
  })
  const origPacket = await s.broker.persistence.incomingGetPacket(sid, toPublish)
  delete origPacket.brokerId
  delete origPacket.brokerCounter
  t.assert.deepEqual(origPacket, toPublish, 'packet must match')
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
