import { test } from 'node:test'
import { once } from 'node:events'
import { Duplex } from 'node:stream'
import {
  brokerPublish,
  checkNoPacket,
  connect,
  createAndConnect,
  delay,
  nextPacket,
  setup,
  subscribe,
  subscribeMultiple,
  withTimeout
} from './helper.js'
import defaultExport, { Aedes } from '../aedes.js'
import write from '../lib/write.js'

test('test Aedes constructor', (t) => {
  t.plan(1)
  const aedes = new Aedes()
  t.assert.equal(aedes instanceof Aedes, true, 'Aedes constructor works')
})

test('test warning on default export', (t) => {
  t.plan(1)
  t.assert.throws(defaultExport, 'received expected error')
})

test('test aedes.createBroker', async (t) => {
  t.plan(1)
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  await connect(setup(broker))
  t.assert.ok(true, 'connected')
})

test('test non-async persistence.setup throws error', async (t) => {
  t.plan(1)

  class P {
    setup () {
      console.log('I am a synchronous setup function')
    }
  }

  const p = new P()
  const broker = new Aedes({ persistence: p })
  t.after(() => broker.close())
  try {
    await broker.listen()
  } catch (_err) {
    t.assert.ok(true, 'receiving expected error')
  }
})

test('publish QoS 0', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false,
    clientId: 'my-client'
  }

  await new Promise(resolve => {
    s.broker.mq.on('hello', (packet, cb) => {
      expected.brokerId = s.broker.id
      expected.brokerCounter = s.broker.counter
      t.assert.equal(packet.messageId, undefined, 'MUST not contain a packet identifier in QoS 0')
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
      cb()
      resolve()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
})

test('messageId shoud reset to 1 if it reached 65535', async (t) => {
  t.plan(7)

  const s = await createAndConnect(t)

  const publishPacket = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  }
  let count = 0
  let pubacks = 0
  let published = 0

  const [client] = await once(s.broker, 'clientReady')
  await subscribe(t, s, 'hello', 1)
  client._nextId = 65535

  const checkResults = async () => {
    for await (const packet of s.outStream) {
      if (packet.cmd === 'puback') {
        t.assert.equal(packet.messageId, 42)
        pubacks++
      }
      if (packet.cmd === 'publish') {
        t.assert.equal(packet.messageId, count++ === 0 ? 65535 : 1)
        published++
      }
      if (pubacks === 2 && published === 2) {
        break
      }
    }
  }
  const publishPackets = () => {
    s.inStream.write(publishPacket)
    s.inStream.write(publishPacket)
  }
  // run parallel
  await Promise.all([publishPackets(), checkResults()])
})

test('publish empty topic throws error', async (t) => {
  t.plan(2)
  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: '',
    payload: 'world'
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client)
  t.assert.ok(err, 'should emit error')
})

test('publish to $SYS topic throws error', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  s.inStream.write({
    cmd: 'publish',
    topic: '$SYS/not/allowed',
    payload: 'world'
  })

  const [client, err] = await once(s.broker, 'clientError')
  t.assert.ok(client)
  t.assert.ok(err, 'should emit error')
})

for (const ele of [
  { qos: 0, clean: false },
  { qos: 0, clean: true },
  { qos: 1, clean: false },
  { qos: 1, clean: true }
]) {
  test('subscribe a single topic in QoS ' + ele.qos + ' [clean=' + ele.clean + ']', async (t) => {
    t.plan(5)

    const s = await createAndConnect(t, { connect: { clean: ele.clean } })

    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      dup: false,
      length: 12,
      qos: 0,
      retain: false
    }
    const expectedSubs = ele.clean
      ? []
      : [
          {
            topic: 'hello',
            qos: ele.qos,
            rh: undefined,
            rap: undefined,
            nl: undefined
          }
        ]

    await subscribe(t, s, 'hello', ele.qos)
    const subs = await s.broker.persistence.subscriptionsByClient(s.client)
    t.assert.deepEqual(subs, expectedSubs, 'subs match')

    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })

    const packet = await nextPacket(s)
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
  })
}

// Catch invalid packet writeToStream errors
test('return write errors to callback', async (t) => {
  t.plan(1)

  const client = {
    conn: {
      writable: true,
      write: () => { throw new Error('error') }
    },
    connecting: true
  }
  await new Promise(resolve => {
    write(client, {}, err => {
      t.assert.equal(err.message, 'packet received not valid', 'should return the error to callback')
      resolve()
    })
  })
})

for (const ele of [
  { qos: 0, clean: false },
  { qos: 0, clean: true },
  { qos: 1, clean: false },
  { qos: 1, clean: true }
]) {
  test('subscribe multipe topics in QoS ' + ele.qos + ' [clean=' + ele.clean + ']', async (t) => {
    t.plan(5)

    const s = await createAndConnect(t, { connect: { clean: ele.clean } })

    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      dup: false,
      length: 12,
      qos: 0,
      retain: false
    }

    const subsToSubscribe = [
      { topic: 'hello', qos: ele.qos, rh: undefined, rap: undefined, nl: undefined },
      { topic: 'world', qos: ele.qos, rh: undefined, rap: undefined, nl: undefined }
    ]
    const expectedSubs = ele.clean ? [] : subsToSubscribe

    await subscribeMultiple(t, s, subsToSubscribe, [ele.qos, ele.qos])
    const subs = await s.broker.persistence.subscriptionsByClient(s.client)
    t.assert.deepEqual(subs, expectedSubs, 'subs match')
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
    const packet = await nextPacket(s)
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
  })
}

test('does not die badly on connection error', async (t) => {
  t.plan(6)
  const s = await createAndConnect(t)

  await subscribe(t, s, 'hello', 0)

  const clientError = async () => {
    const [client, err] = await once(s.broker, 'clientError')
    t.assert.ok(client, 'client is passed')
    t.assert.ok(err, 'err is passed')
  }

  const serverWorking = new Promise(resolve => {
    s.conn.destroy()
    setImmediate(() => {
      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: Buffer.from('world')
      }, () => {
        t.assert.ok(true, 'calls the callback')
        resolve()
      })
    })
  })
  await Promise.all([clientError(), serverWorking])
})

// Guarded in mqtt-packet
test('subscribe should have messageId', async (t) => {
  t.plan(1)
  const s = await createAndConnect(t)

  try {
    s.inStream.write({
      cmd: 'subscribe',
      subscriptions: [{
        topic: 'hello',
        qos: 0
      }]
    })
  } catch (err) {
    t.assert.ok(err.message, 'Invalid messageId')
  }
})

test('subscribe with messageId 0 should return suback', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  s.inStream.write({
    cmd: 'subscribe',
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }],
    messageId: 0
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'suback',
    messageId: 0,
    dup: false,
    length: 3,
    qos: 0,
    retain: false,
    payload: null,
    topic: null,
    granted: [
      0
    ]
  }, 'packet matches')
})

test('unsubscribe', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 0)
  s.inStream.write({
    cmd: 'unsubscribe',
    messageId: 43,
    unsubscriptions: ['hello']
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'unsuback',
    messageId: 43,
    dup: false,
    length: 2,
    qos: 0,
    retain: false,
    payload: null,
    topic: null
  }, 'packet matches')

  await new Promise(resolve => {
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    }, () => {
      t.assert.ok(true, 'publish finished')
      resolve()
    })
  })
  await checkNoPacket(t, s)
})

test('unsubscribe without subscribe', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  s.inStream.write({
    cmd: 'unsubscribe',
    messageId: 43,
    unsubscriptions: ['hello']
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'unsuback',
    messageId: 43,
    dup: false,
    length: 2,
    qos: 0,
    retain: false,
    payload: null,
    topic: null
  }, 'packet matches')
})

test('unsubscribe on disconnect for a clean=true client', async (t) => {
  t.plan(7)

  const opts = { connect: { clean: true } }
  const s = await createAndConnect(t, opts)

  await subscribe(t, s, 'hello', 0)
  s.conn.destroy(null)
  t.assert.equal(s.conn.destroyed, true, 'closed streams')

  const emittedUnsubscribe = async () => {
    await once(s.broker, 'unsubscribe')
    t.assert.ok(true, 'should emit unsubscribe')
  }

  const publishPacket = async () => {
    await brokerPublish(s, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    })
    t.assert.ok(true, 'calls the callback')
  }
  // run parallel
  await Promise.all([checkNoPacket(t, s), emittedUnsubscribe(), publishPacket()])
})

test('unsubscribe on disconnect for a clean=false client', async (t) => {
  t.plan(7)

  const opts = { connect: { clean: false } }
  const s = await createAndConnect(t, opts)

  await subscribe(t, s, 'hello', 0)
  s.conn.destroy(null, () => {
    t.assert.ok(true, 'closed streams')
  })

  const emittedNoUnsubscribe = async () => {
    const result = await withTimeout(once(s.broker, 'unsubscribe'), 10, null)
    t.assert.equal(result, null, 'should not emit unsubscribe')
  }
  const publishPacket = async () => {
    await brokerPublish(s, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    })
    t.assert.ok(true, 'calls the callback')
  }
  // run parallel
  await Promise.all([checkNoPacket(t, s), emittedNoUnsubscribe(), publishPacket()])
})

test('disconnect', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  const checkDisconnect = async () => {
    await once(s.broker, 'clientDisconnect')
    t.assert.ok(true, 'closed stream')
  }

  const disconnect = () => {
    s.inStream.write({
      cmd: 'disconnect'
    })
  }
  // run parallel
  await Promise.all([checkDisconnect(), disconnect()])
})

test('disconnect client on wrong cmd', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)
  s.client._parser.emit('packet', { cmd: 'pippo' })
  await once(s.broker, 'clientDisconnect')
  t.assert.ok(true, 'closed stream')
})

test('client closes', async (t) => {
  t.plan(5)

  const { broker, client } = await createAndConnect(t, { connect: { clientId: 'abcde' } })

  await once(broker, 'clientReady')
  const brokerClient = broker.clients.abcde
  t.assert.equal(brokerClient.connected, true, 'client connected')

  const clientClosed = async () => {
    await once(client.conn, 'close')
    t.assert.ok(true, 'client disconnected')
  }
  const closeAll = new Promise(resolve => {
    setImmediate(() => {
      brokerClient.close(() => {
        t.assert.equal(broker.clients.abcde, undefined, 'client instance is removed')
      })
      t.assert.equal(brokerClient.connected, false, 'client disconnected')
      broker.close((err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })
  // run parallel
  await Promise.all([clientClosed(), closeAll])
})

test('broker closes', async (t) => {
  t.plan(4)

  const { broker, client } = await createAndConnect(t, { connect: { clientId: 'abcde' } })

  const clientClosed = async () => {
    await once(client.conn, 'close')
    t.assert.ok(true, 'client closes')
  }

  const brokerClose = new Promise(resolve => {
    broker.close((err) => {
      t.assert.ok(!err, 'no error')
      t.assert.ok(broker.closed)
      t.assert.equal(broker.clients.abcde, undefined, 'client instance is removed')
      resolve()
    })
  })
  // run parallel
  await Promise.all([clientClosed(), brokerClose])
})

test('broker closes gracefully', async (t) => {
  t.plan(7)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s1 = setup(broker)
  await connect(s1, { connect: { clientId: 'my-client-1' } })
  const s2 = setup(broker)
  await connect(s2, { connect: { clientId: 'my-client-2' } })
  t.assert.equal(broker.connectedClients, 2, '2 connected clients')
  const client1Closed = async () => {
    await once(s1.client.conn, 'close')
    t.assert.ok(true, 'client1 closes')
  }
  const client2Closed = async () => {
    await once(s2.client.conn, 'close')
    t.assert.ok(true, 'client2 closes')
  }
  const brokerClose = new Promise(resolve => {
    broker.close((err) => {
      t.assert.ok(!err, 'no error')
      t.assert.ok(broker.mq.closed, 'broker mq closes')
      t.assert.ok(broker.closed, 'broker closes')
      t.assert.equal(broker.connectedClients, 0, 'no connected clients')
      resolve()
    })
  })
  // run parallel
  await Promise.all([client1Closed(), client2Closed(), brokerClose])
})

test('testing other event', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  // can't use default setup because of errothandling on duplexPair
  const server = new Duplex()
  broker.handle(server)

  const connectionError = async () => {
    const [client] = await once(broker, 'connectionError')
    t.assert.ok(!client.id, 'client not present')
  }
  const emitError = () => {
    server.emit('error', 'Connect not yet arrived')
  }

  // run parallel
  await Promise.all([
    connectionError(),
    emitError()
  ])
})

test('connect without a clientId for MQTT 3.1.1', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s1 = setup(broker)
  const packet = await connect(s1, { noClientId: true })
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'connack',
    returnCode: 0,
    length: 2,
    qos: 0,
    retain: false,
    dup: false,
    topic: null,
    payload: null,
    sessionPresent: false
  }, 'successful connack')
})

test('disconnect existing client with the same clientId', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s1 = setup(broker)
  await connect(s1, { clientId: 'abcde' })
  const s2 = setup(broker)
  await connect(s2, { clientId: 'abcde' })
  t.assert.equal(s2.conn.closed, false, 's2 is still connected')
  t.assert.equal(s1.conn.closed, true, 's1 has been disconnected')
})

test('disconnect if another broker connects the same clientId', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, { connect: { clientId: 'abcde' } })
  await brokerPublish(s, {
    topic: '$SYS/anotherBroker/new/clients',
    payload: Buffer.from('abcde')
  })
  t.assert.equal(s.conn.closed, true, 'client has been disconnected')
})

test('publish to $SYS/broker/new/clients', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  const brokerBroadcasted = new Promise(resolve => {
    broker.mq.on(`$SYS/${broker.id}/new/clients`, (packet, done) => {
      t.assert.equal(packet.payload.toString(), 'abcde', 'clientId matches')
      resolve()
      done()
    })
  })
  // run parallel
  await Promise.all([
    brokerBroadcasted,
    connect(s, { connect: { clientId: 'abcde' } })
  ])
})

test('publish to $SYS/broker/new/subscribers and $SYS/broker/new/unsubscribers', async (t) => {
  t.plan(7)

  const subscriber = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = subscriber.broker

  const sub = {
    topic: 'hello',
    qos: 0
  }

  const subscribeBroadcasted = new Promise(resolve => {
    broker.mq.on(`$SYS/${broker.id}/new/subscribes`, (packet, done) => {
      const payload = JSON.parse(packet.payload.toString())
      t.assert.equal(payload.clientId, 'abcde', 'clientId matches')
      t.assert.deepEqual(payload.subs, [sub], 'subscriptions matches')
      resolve()
      done()
    })
  })

  const unsubscribeBroadcasted = new Promise(resolve => {
    broker.mq.on(`$SYS/${broker.id}/new/unsubscribes`, (packet, done) => {
      const payload = JSON.parse(packet.payload.toString())
      t.assert.equal(payload.clientId, 'abcde', 'clientId matches')
      t.assert.deepEqual(payload.subs, [sub.topic], 'unsubscriptions matches')
      resolve()
      done()
    })
  })

  const subUnsub = async () => {
    await subscribe(t, subscriber, sub.topic, sub.qos)
    subscriber.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })
  }
  // run parallel
  await Promise.all([
    subscribeBroadcasted,
    unsubscribeBroadcasted,
    subUnsub()
  ])
})

test('restore QoS 0 subscriptions not clean', async (t) => {
  t.plan(5)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  const subscriber = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = subscriber.broker
  await subscribe(t, subscriber, 'hello', 0)
  // hangup
  subscriber.inStream.end()

  // start second connection
  const publisher = setup(broker)
  await connect(publisher)
  // start third connection
  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: false, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, true, 'session present is set to true')
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0
  })
  const packet = await nextPacket(subscriber2)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet must match')
})

test('do not restore QoS 0 subscriptions when clean', async (t) => {
  t.plan(6)

  const subscriber = await createAndConnect(t, { connect: { clean: true, clientId: 'abcde' } })
  const broker = subscriber.broker
  await subscribe(t, subscriber, 'hello', 0)
  // hangup
  subscriber.inStream.end()

  const subs = await subscriber.broker.persistence.subscriptionsByClient(broker.clients.abcde)
  t.assert.deepEqual(subs, [], 'no previous subscriptions restored')

  const publisher = setup(broker)
  await connect(publisher)
  const subscriber2 = setup(broker)
  const connack = await connect(subscriber2, { connect: { clean: true, clientId: 'abcde' } })
  t.assert.equal(connack.sessionPresent, false, 'session present is set to false')
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0
  })
  await checkNoPacket(t, subscriber2)
})

test('double sub does not double deliver', async (t) => {
  t.plan(8)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  const s = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  await subscribe(t, s, 'hello', 0)
  await subscribe(t, s, 'hello', 0)

  s.broker.publish({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
  await checkNoPacket(t, s)
})

test('overlapping sub does not double deliver', async (t) => {
  t.plan(8)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }
  const s = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  await subscribe(t, s, 'hello', 0)
  await subscribe(t, s, 'hello/#', 0)

  s.broker.publish({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
  await checkNoPacket(t, s)
})

test('clear drain', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 0)

  // fake a busy socket
  let written = false // 1 packet requires multiple writes, just count 1
  s.client.conn.write = (chunk, enc, cb) => {
    if (!written) {
      t.assert.ok(true, 'write called')
      written = true
    }
    return false
  }

  const publish = async () => {
    await brokerPublish(s, {
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })

    t.assert.ok(true, 'published packet')
  }

  // run parallel
  await Promise.all([
    publish(),
    s.client.conn.destroy()
  ])
})

test('id option', (t) => {
  t.plan(2)

  const broker1 = new Aedes()
  t.assert.ok(broker1.id, 'broker gets random id when id option not set')

  const broker2 = new Aedes({ id: 'abc' })
  t.assert.equal(broker2.id, 'abc', 'broker id equals id option when set')
})

test('not duplicate client close when client error occurs', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  const checkDoubleDrain = async () => {
    await once(s.client.conn, 'drain')
    t.assert.ok(true, 'client closed ok')
    const result = await withTimeout(once(s.client.conn, 'drain'), 10, ['timeout'])
    t.assert.equal(result, 'timeout', 'no double client close calls')
  }

  // run parallel
  await Promise.all([
    checkDoubleDrain(),
    s.client.close()
  ])
})

test('not duplicate client close when double close() called', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)
  const checkDoubleDrain = async () => {
    await once(s.client.conn, 'drain')
    t.assert.ok(true, 'client closed ok')
    const result = await withTimeout(once(s.client.conn, 'drain'), 10, ['timeout'])
    t.assert.equal(result, 'timeout', 'no double client close calls')
  }
  const doubleClose = async () => {
    s.client.close()
    await delay(1)
    s.client.close()
  }

  // run parallel
  await Promise.all([
    checkDoubleDrain(),
    doubleClose()
  ])
})
