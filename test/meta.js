import { test } from 'node:test'
import { once } from 'node:events'
import {
  connect,
  createAndConnect,
  delay,
  nextPacket,
  setup,
  subscribe,
  withTimeout
} from './helperAsync.js'
import { Aedes } from '../aedes.js'
import pkg from '../package.json' with { type: 'json' }
const version = pkg.version

test('count connected clients', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  t.assert.equal(broker.connectedClients, 0, 'no connected clients')

  await connect(setup(broker), { autoClientId: true })
  t.assert.equal(broker.connectedClients, 1, 'one connected clients')

  const last = setup(broker)
  await connect(last, { autoClientId: true })
  t.assert.equal(broker.connectedClients, 2, 'two connected clients')

  last.conn.destroy()

  // needed because destroy() will do the trick before
  // the next tick
  await delay(0)
  t.assert.equal(broker.connectedClients, 1, 'one connected clients')
})

test('call published method', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  broker.published = (packet, client, done) => {
    t.assert.equal(packet.topic, 'hello', 'topic matches')
    t.assert.equal(packet.payload.toString(), 'world', 'payload matches')
    t.assert.equal(client, null, 'no client')
    done()
  }

  await new Promise((resolve) => {
    broker.publish({
      topic: 'hello',
      payload: Buffer.from('world')
    }, err => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })
})

test('call published method with client', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  const checkPublished = new Promise(resolve => {
    s.broker.published = (packet, client, done) => {
      // for internal messages, client will be null
      if (client) {
        t.assert.equal(packet.topic, 'hello', 'topic matches')
        t.assert.equal(packet.payload.toString(), 'world', 'payload matches')
        t.assert.equal(packet.qos, 1)
        t.assert.equal(packet.messageId, 42)
        done()
        resolve()
      }
    }
  })

  const sendPacket = () => {
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1,
      messageId: 42
    })
  }
  // run parallel
  await Promise.all([checkPublished, sendPacket()])
})

test('emit publish event with client - QoS 0', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  const checkPublished = async () => {
    const [packet, client] = await once(s.broker, 'publish')
    // for internal messages, client will be null
    t.assert.ok(client, 'client is present')
    t.assert.equal(packet.qos, 0)
    t.assert.equal(packet.topic, 'hello', 'topic matches')
    t.assert.equal(packet.payload.toString(), 'world', 'payload matches')
  }

  const sendPacket = () => {
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0
    })
  }
  await Promise.all([checkPublished(), sendPacket()])
})

test('emit publish event with client - QoS 1', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  const checkPublished = async () => {
    const [packet, client] = await once(s.broker, 'publish')
    // for internal messages, client will be null
    t.assert.ok(client, 'client is present')
    t.assert.equal(packet.messageId, 42)
    t.assert.equal(packet.qos, 1)
    t.assert.equal(packet.topic, 'hello', 'topic matches')
    t.assert.equal(packet.payload.toString(), 'world', 'payload matches')
  }

  const sendPacket = () => {
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1,
      messageId: 42
    })
  }
  await Promise.all([checkPublished(), sendPacket()])
})

test('emit subscribe event', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t, { connect: { clientId: 'abcde' } })

  const checkSubscribe = async () => {
    const [subscriptions, client] = await once(s.broker, 'subscribe')
    t.assert.deepEqual(subscriptions, [{
      topic: 'hello',
      qos: 0
    }], 'topic matches')
    t.assert.equal(subscriptions[0].qos, 0)
    t.assert.equal(client.id, 'abcde', 'client matches')
  }

  // run parallel
  await Promise.all([
    checkSubscribe(),
    subscribe(t, s, 'hello', 0)
  ])
})

test('emit subscribe event if unrecognized params in subscribe packet structure', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const subs = [{ topic: 'hello', qos: 0 }]

  const checkSubscribe = async () => {
    const [subscriptions, client] = await once(s.broker, 'subscribe')
    t.assert.equal(subscriptions, subs)
    t.assert.deepEqual(client, s.client)
  }

  const doSubscribe = new Promise((resolve) => {
    s.client.subscribe({
      subscriptions: subs,
      close: true
    }, err => {
      t.assert.ok(!err)
      resolve()
    })
  })

  // run parallel
  await Promise.all([
    checkSubscribe(),
    doSubscribe
  ])
})

test('emit unsubscribe event', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t, { connect: { clean: true, clientId: 'abcde' } })

  const checkUnsubscribe = async () => {
    const [unsubscriptions, client] = await once(s.broker, 'unsubscribe')
    t.assert.deepEqual(unsubscriptions, [
      'hello'
    ], 'unsubscription matches')
    t.assert.equal(client.id, 'abcde', 'client matches')
  }

  const doUnsubscribe = async () => {
    await subscribe(t, s, 'hello', 0)
    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })
  }
  // run parallel
  await Promise.all([
    checkUnsubscribe(),
    doUnsubscribe()
  ])
})

// TODO unsubscribe event is not emitted
// remove { skip: true} once this is fixed
test('emit unsubscribe event if unrecognized params in unsubscribe packet structure', { skip: true }, async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const unsubs = [{ topic: 'hello', qos: 0 }]

  const checkUnsubscribe = async () => {
    const [unsubscriptions, client] = await once(s.broker, 'unsubscribe')
    t.assert.equal(unsubscriptions, unsubs)
    t.assert.deepEqual(client, s.client)
  }

  const doUnsubscribe = new Promise((resolve) => {
    s.client.unsubscribe({
      unsubscriptions: unsubs,
      close: true
    }, err => {
      t.assert.ok(!err)
      resolve()
    })
  })

  // run parallel
  await Promise.all([
    checkUnsubscribe(),
    doUnsubscribe
  ])
})

// TODO: Aedes does emit an unsubscribe event on client close
// remove { skip: true} once this is fixed
test('dont emit unsubscribe event on client close', { skip: true }, async (t) => {
  t.plan(5)

  const s = await createAndConnect(t, { connect: { clientId: 'abcde' } })

  const checkUnsubscribe = async () => {
    const [result] = await withTimeout(once(s.broker, 'unsubscribe'), 100, ['timeout'])
    console.log(result)
    t.assert.deepEqual(result, 'timeout', 'unsubscribe should not be emitted')
  }

  const doSubscribe = async () => {
    await subscribe(t, s, 'hello', 0)
    s.inStream.end({
      cmd: 'disconnect'
    })
    const packet = await nextPacket(s)
    t.assert.equal(packet, null, 'no packet')
  }

  // run parallel
  await Promise.all([
    checkUnsubscribe(),
    doSubscribe()
  ])
})

test('emit clientDisconnect event', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, { connect: { clientId: 'abcde' } })

  const checkDisconnect = async () => {
    const [client] = await once(s.broker, 'clientDisconnect')
    t.assert.equal(client.id, 'abcde', 'client matches')
  }

  const disconnect = () => {
    s.inStream.end({
      cmd: 'disconnect'
    })
  }

  // run parallel
  await Promise.all([
    checkDisconnect(),
    disconnect()
  ])
})

test('emits client', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const checkClient = async () => {
    const [client] = await once(broker, 'client')
    t.assert.equal(client.id, 'abcde', 'client matches')
  }

  const doConnect = async () => {
    const s = setup(broker)
    await connect(s, { connect: { clientId: 'abcde' } })
  }
  // run parallel
  await Promise.all([
    checkClient(),
    doConnect()
  ])
})

test('get aedes version', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  t.assert.equal(broker.version, version)
})

test('connect and connackSent event', { timeout: 50 }, async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  const s = setup(broker)
  t.after(() => broker.close())

  const clientId = 'my-client'

  const checkConnack = async () => {
    const [packet, client] = await once(s.broker, 'connackSent')
    t.assert.equal(packet.returnCode, 0)
    t.assert.equal(client.id, clientId, 'connackSent event and clientId matches')
  }

  const doConnect = async () => {
    const packet = await connect(s, { connect: { clientId, clean: true, keepalive: 0 } })
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
  }
  // run parallel
  await Promise.all([
    checkConnack(),
    doConnect()
  ])
})
