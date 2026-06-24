import { test } from 'node:test'
import { once } from 'node:events'
import {
  connect,
  createAndConnect,
  delay,
  setup,
} from './helper.js'
import memory from 'aedes-persistence'
import { Aedes } from '../aedes.js'

async function memorySetup (opts) {
  const persistence = memory()
  await persistence.setup(opts)
  return persistence
}

function addWillToOpts (opts = {}) {
  opts.will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }
  return opts
}

async function oneWillFromBroker (broker) {
  let received
  const packet = await new Promise(resolve => {
    received = willsFromBroker(broker, resolve)
  })
  return { packet, received }
}

function willsFromBroker (broker, resolve) {
  const received = []
  broker.mq.on('mywill', (packet, cb) => {
    received.push(packet)
    cb()
    if (resolve) {
      resolve(packet)
      resolve = null
    }
  })
  return received
}

test('delivers a will', async (t) => {
  t.plan(4)

  const opts = addWillToOpts({})
  const s = await createAndConnect(t, { connect: opts })
  s.conn.destroy()

  const { packet } = await oneWillFromBroker(s.broker)
  t.assert.equal(packet.topic, opts.will.topic, 'topic matches')
  t.assert.deepEqual(packet.payload, opts.will.payload, 'payload matches')
  t.assert.equal(packet.qos, opts.will.qos, 'qos matches')
  t.assert.equal(packet.retain, opts.will.retain, 'retain matches')
})

test('calling close two times should not deliver two wills', async (t) => {
  t.plan(5)

  const opts = addWillToOpts({})
  const s = await createAndConnect(t, { connect: opts })

  const received = willsFromBroker(s.broker)
  s.client.close()
  s.client.close()
  await delay(10) // give Aedes some time to process, potentially twice
  t.assert.equal(received.length, 1, 'only one will has been delivered')
  const packet = received[0]
  t.assert.equal(packet.topic, opts.will.topic, 'topic matches')
  t.assert.deepEqual(packet.payload, opts.will.payload, 'payload matches')
  t.assert.equal(packet.qos, opts.will.qos, 'qos matches')
  t.assert.equal(packet.retain, opts.will.retain, 'retain matches')
})

test('delivers old will in case of a crash', async (t) => {
  t.plan(8)

  const persistence = await memorySetup({ id: 'anotherBroker' })
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }
  await persistence.putWill({ id: 'myClientId42' }, will)

  let authorized = false
  const interval = 10 // ms, so that the will check happens fast!
  const broker = await Aedes.createBroker({
    persistence,
    heartbeatInterval: interval,
    authorizePublish: (client, packet, callback) => {
      t.assert.equal(client, null, 'client must be null')
      authorized = true
      callback(null)
    }
  })

  t.after(() => broker.close())

  const start = Date.now()

  const { packet, received } = await oneWillFromBroker(broker)
  t.assert.ok(Date.now() - start >= 3 * interval, 'the will needs to be emitted after 3 heartbeats')
  t.assert.equal(packet.topic, will.topic, 'topic matches')
  t.assert.deepEqual(packet.payload, will.payload, 'payload matches')
  t.assert.equal(packet.qos, will.qos, 'qos matches')
  t.assert.equal(packet.retain, will.retain, 'retain matches')
  t.assert.equal(authorized, true, 'authorization called')
  await delay(10) // give Aedes some time to process, potentially twice
  t.assert.equal(received.length, 1, 'only one will has been delivered')
})

test('delivers many old wills in case of a crash', async (t) => {
  t.plan(1)

  const numWills = 100
  const persistence = await memorySetup({ id: 'anotherBroker' })
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  for (let id = 0; id < numWills; id++) {
    const cWill = structuredClone(will)
    cWill.topic = 'mywill'
    await persistence.putWill({ id: `myClientId${id}` }, cWill)
  }

  const interval = 10 // ms, so that the will check happens fast!
  const broker = await Aedes.createBroker({
    persistence,
    heartbeatInterval: interval,
    authorizePublish: (client, packet, callback) => {
      callback(null)
    }
  })

  t.after(() => broker.close())

  const received = await willsFromBroker(broker)
  await delay(100) // give Aedes some time to process to ensure that all wills are sent
  t.assert.equal(received.length, numWills, 'all wills have been delivered')
})

test('deliver old will without authorization in case of a crash', async (t) => {
  t.plan(1)

  const persistence = await memorySetup({ id: 'anotherBroker' })

  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  await persistence.putWill({ id: 'myClientId42' }, will)

  const interval = 10 // ms, so that the will check happens fast!
  const broker = await Aedes.createBroker({
    persistence,
    heartbeatInterval: interval,
    authorizePublish: function (client, packet, callback) {
      t.assert.equal(client, null, 'client must be null')
      callback(new Error())
    }
  })
  t.after(() => broker.close())
  const received = willsFromBroker(broker)
  await delay(10) // give Aedes some time to process to ensure that no will is send
  t.assert.equal(received.length, 0, 'no will has been delivered')
})

test('delete old broker', async (t) => {
  t.plan(1)

  const heartbeatInterval = 100
  const broker = await Aedes.createBroker({
    heartbeatInterval
  })
  t.after(() => broker.close())

  const brokerId = 'dummyBroker'

  broker.brokers[brokerId] = Date.now() - heartbeatInterval * 3.5

  await delay(heartbeatInterval * 4)
  t.assert.equal(broker.brokers[brokerId], undefined, 'Broker deleted')
})

test('store the will in the persistence', async (t) => {
  t.plan(4)

  const opts = addWillToOpts({
    clientId: 'abcde'
  })

  const s = await createAndConnect(t, { connect: opts })

  const packet = await s.broker.persistence.getWill({ id: opts.clientId })
  t.assert.deepEqual(structuredClone(packet).topic, opts.will.topic, 'will topic matches')
  t.assert.deepEqual(structuredClone(packet).payload, opts.will.payload, 'will payload matches')
  t.assert.deepEqual(structuredClone(packet).qos, opts.will.qos, 'will qos matches')
  t.assert.deepEqual(structuredClone(packet).retain, opts.will.retain, 'will retain matches')
})

test('delete the will in the persistence after publish', async (t) => {
  t.plan(1)

  const opts = addWillToOpts({
    clientId: 'abcde'
  })

  const s = await createAndConnect(t, { connect: opts })

  await new Promise(resolve => {
    willsFromBroker(s.broker, resolve) // setup the listener
    s.client.close()
  })
  const packet = await s.broker.persistence.getWill({ id: opts.clientId })
  t.assert.ok(!packet, 'packet is empty')
})

test('delivers a will with authorization', async (t) => {
  t.plan(7)

  let authorized = false

  const opts = addWillToOpts({})
  const s = await createAndConnect(t, {
    broker: {
      authorizePublish: (client, packet, callback) => {
        authorized = true
        callback(null)
      }
    },
    connect: opts
  })

  const received = willsFromBroker(s.broker)
  s.conn.destroy()

  const [client] = await once(s.broker, 'clientDisconnect')
  t.assert.equal(client.connected, false)
  t.assert.equal(received.length, 1, 'only one will has been delivered')
  const packet = received[0]
  t.assert.equal(packet.topic, opts.will.topic, 'topic matches')
  t.assert.deepEqual(packet.payload, opts.will.payload, 'payload matches')
  t.assert.equal(packet.qos, opts.will.qos, 'qos matches')
  t.assert.equal(packet.retain, opts.will.retain, 'retain matches')
  t.assert.equal(authorized, true, 'authorization called')
})

test('delivers a will waits for authorization', async (t) => {
  t.plan(7)

  let authorized = false
  const opts = addWillToOpts({})
  const s = await createAndConnect(t, {
    broker: {
      authorizePublish: (client, packet, callback) => {
        authorized = true
        setImmediate(() => { callback(null) })
      }
    },
    connect: opts
  })
  const received = willsFromBroker(s.broker)
  s.conn.destroy()

  const [client] = await once(s.broker, 'clientDisconnect')
  t.assert.equal(client.connected, false)
  t.assert.equal(authorized, true, 'authorization called')
  await delay(10) // give Aedes time to complete authorizePublish
  t.assert.equal(received.length, 1, 'only one will has been delivered')
  const packet = received[0]
  t.assert.equal(packet.topic, opts.will.topic, 'topic matches')
  t.assert.deepEqual(structuredClone(packet).payload, opts.will.payload, 'payload matches')
  t.assert.equal(packet.qos, opts.will.qos, 'qos matches')
  t.assert.equal(packet.retain, opts.will.retain, 'retain matches')
})

test('does not deliver a will without authorization', async (t) => {
  t.plan(2)

  let authorized = false
  const opts = addWillToOpts({})
  const s = await createAndConnect(t, {
    broker: {
      authorizePublish: (client, packet, callback) => {
        authorized = true
        callback(new Error())
      }
    },
    connect: opts
  })
  const received = willsFromBroker(s.broker)
  s.conn.destroy()

  await once(s.broker, 'clientDisconnect')
  t.assert.equal(authorized, true, 'authorization called')
  await delay(10) // give Aedes time to complete authorizePublish
  t.assert.equal(received.length, 0, 'received no will without authorization')
})

test('does not deliver a will without authentication', async (t) => {
  t.plan(2)

  let authenticated = false
  const opts = addWillToOpts({})
  const s = await createAndConnect(t, {
    broker: {
      authenticate: (client, username, password, callback) => {
        authenticated = true
        callback(new Error(), false)
      }
    },
    connect: opts,
    expectedReturnCode: 5
  })
  const received = willsFromBroker(s.broker)
  await once(s.broker, 'clientError')
  t.assert.equal(authenticated, true, 'authentication called')
  await delay(10) // give Aedes time to complete authenticate
  t.assert.equal(received.length, 0, 'received no will without authentication')
})

test('does not deliver will if broker is closed during authentication', async (t) => {
  t.plan(2)

  const opts = addWillToOpts({ keepalive: 1 })

  const broker = await Aedes.createBroker()
  broker.authenticate = (client, username, password, callback) => {
    setImmediate(() => {
      callback(null, true)
    })
    broker.close()
  }

  broker.on('keepaliveTimeout', () => {
    t.assert.fail('keepalive timer shoud not be set')
  })

  const received = willsFromBroker(broker)

  const s = setup(broker)
  await connect(s, { connect: opts, noWait: true })
  await delay(1) // give Aedes some time to close the broker
  t.assert.equal(broker.closed, true, 'broker closed')
  t.assert.equal(received.length, 0, 'received no will')
})

// [MQTT-3.14.4-3]
test('does not deliver will when client sends a DISCONNECT', async (t) => {
  t.plan(2)

  const opts = addWillToOpts({ keepalive: 1 })
  const s = await createAndConnect(t, { connect: opts })
  const received = willsFromBroker(s.broker)
  s.inStream.write({
    cmd: 'disconnect'
  })

  await once(s.broker, 'clientDisconnect')
  t.assert.ok(!s.client.connected, 'disconnected')
  t.assert.equal(received.length, 0, 'received no will')
})

test('deletes from persistence on DISCONNECT', async (t) => {
  t.plan(1)

  const opts = addWillToOpts({
    clientId: 'abcde'
  })
  const s = await createAndConnect(t, { connect: opts })
  s.inStream.end({
    cmd: 'disconnect'
  })
  await once(s.broker, 'clientDisconnect')
  const packet = await s.broker.persistence.getWill({ id: opts.clientId })
  t.assert.ok(!packet, 'no packet present')
})

test('does not store multiple will with same clientid', async (t) => {
  t.plan(2)

  const opts = addWillToOpts({
    clientId: 'abcde'
  })
  const s = await createAndConnect(t, { connect: opts })
  s.inStream.end({
    cmd: 'disconnect'
  })
  await once(s.broker, 'clientDisconnect')
  const s2 = setup(s.broker)
  await connect(s2, { connect: opts })

  // check that there are not 2 will messages for the same clientid
  const packet1 = await s.broker.persistence.delWill({ id: opts.clientId })
  t.assert.equal(packet1.clientId, opts.clientId, 'will packet found')
  const packet2 = await s.broker.persistence.delWill({ id: opts.clientId })
  t.assert.ok(!packet2, 'no duplicate will packets')
})

test('don\'t deliver a will if broker alive', async (t) => {
  t.plan(6)
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  const oldBroker = 'broker1'

  const persistence = await memorySetup({ id: oldBroker })
  await persistence.putWill({ id: 'myClientId42' }, will)

  const opts = {
    persistence,
    heartbeatInterval: 10
  }

  const broker = await Aedes.createBroker(opts)
  t.after(() => broker.close())

  const streamWill = persistence.streamWill
  persistence.streamWill = () => {
    // don't pass broker.brokers to streamWill
    return streamWill.call(persistence)
  }
  // catch any wills published
  const received = willsFromBroker(broker)

  // let the broker run for 5 heartbeats
  let count = 0
  await new Promise((resolve) => {
    broker.mq.on('$SYS/+/heartbeat', () => {
      t.assert.ok(true, 'Heartbeat received')
      broker.brokers[oldBroker] = Date.now()
      if (++count === 5) {
        resolve()
      }
    })
  })
  t.assert.equal(received.length, 0, 'received no will')
})

test('handle will publish error', async (t) => {
  t.plan(1)

  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  const persistence = await memorySetup({ id: 'broker1' })
  await persistence.putWill({ id: 'myClientId42' }, will)

  const opts = {
    persistence,
    heartbeatInterval: 10
  }

  // fake an error
  persistence.delWill = async client => {
    throw new Error('Throws error')
  }

  const broker = await Aedes.createBroker(opts)
  t.after(() => broker.close())

  const [err] = await once(broker, 'error')
  t.assert.equal('Throws error', err.message, 'throws error')
})

test('handle will publish error 2', async (t) => {
  t.plan(1)

  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: true
  }

  const persistence = await memorySetup({ id: 'broker1' })
  await persistence.putWill({ id: 'myClientId42' }, will)

  const opts = {
    persistence,
    heartbeatInterval: 10
  }

  // fake error
  persistence.storeRetained = async packet => {
    throw new Error('Throws error')
  }

  const broker = await Aedes.createBroker(opts)
  t.after(() => broker.close())

  const [err] = await once(broker, 'error')
  t.assert.equal('Throws error', err.message, 'throws error')
})
