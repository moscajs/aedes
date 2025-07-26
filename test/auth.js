import { test } from 'node:test'
import { once } from 'node:events'
import Client from '../lib/client.js'
import {
  connect,
  createAndConnect,
  nextPacket,
  nextPacketWithTimeOut,
  setup,
  subscribe,
  subscribeMultiple,
} from './helperAsync.js'
import { Aedes } from '../aedes.js'

async function testAuthenticationError (t, errObject, expectedReturnCode) {
  const authenticate = (client, username, password, cb) => {
    t.assert.equal(client instanceof Client, true, 'client is there')
    t.assert.equal(username, 'my username', 'username is there')
    t.assert.equal(password.toString(), 'my pass', 'password is there')
    cb(errObject, null)
  }
  const broker = await Aedes.createBroker({ authenticate })
  t.after(() => broker.close())
  broker.on('clientReady', (client) => {
    throw new Error('client should not ready')
  })
  const packet = await connect(setup(broker), { verifyReturnedOk: false })
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'connack',
    returnCode: expectedReturnCode,
    length: 2,
    qos: 0,
    retain: false,
    dup: false,
    topic: null,
    payload: null,
    sessionPresent: false
  }, 'unsuccessful connack, unauthorized')
  const [client, err] = await once(broker, 'clientError')
  t.assert.equal(client.id, 'my-client')
  t.assert.equal(err.errorCode, expectedReturnCode)
  t.assert.equal(err.message, 'Auth error')
  t.assert.equal(broker.connectedClients, 0, 'no connected clients')
}

test('authenticate successfully a client with username and password', async (t) => {
  t.plan(5)
  const authenticate = (client, username, password, cb) => {
    t.assert.equal(client instanceof Client, true, 'client is there')
    t.assert.equal(username, 'my username', 'username is there')
    t.assert.equal(password.toString(), 'my pass', 'password is there')
    cb(null, true)
  }
  const broker = await Aedes.createBroker()
  // explicitly override authenticate instead of passing it as a parameter
  broker.authenticate = authenticate
  t.after(() => broker.close())
  const packet = await connect(setup(broker))
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
  t.assert.equal(broker.connectedClients, 1, 'one connected client')
})

test('authenticate unsuccessfully a client with username and password', async (t) => {
  t.plan(7)
  const authenticate = (client, username, password, cb) => {
    t.assert.equal(client instanceof Client, true, 'client is there')
    t.assert.equal(username, 'my username', 'username is there')
    t.assert.equal(password.toString(), 'my pass', 'password is there')
    cb(null, false)
  }
  const broker = await Aedes.createBroker({ authenticate })
  t.after(() => broker.close())
  broker.on('clientReady', (client) => {
    throw new Error('client should not ready')
  })

  const packet = await connect(setup(broker), { verifyReturnedOk: false })
  t.assert.deepEqual(structuredClone(packet), {
    cmd: 'connack',
    returnCode: 5,
    length: 2,
    qos: 0,
    retain: false,
    dup: false,
    topic: null,
    payload: null,
    sessionPresent: false
  })
  const [client, err] = await once(broker, 'clientError')
  t.assert.equal(client.id, 'my-client')
  t.assert.equal(err.errorCode, 5)
  t.assert.equal(broker.connectedClients, 0, 'no connected clients')
})

test('authenticate errors', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 1
  await testAuthenticationError(t, error, 5)
})

test('authentication error when return code 1 (unacceptable protocol version) is passed', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 1
  await testAuthenticationError(t, error, 5)
})

test('authentication error when return code 2 (identifier rejected) is passed', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 2
  await testAuthenticationError(t, error, 2)
})

test('authentication error when return code 3 (Server unavailable) is passed', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 3
  await testAuthenticationError(t, error, 3)
})

test('authentication error when return code 4 (bad user or password) is passed', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 4
  await testAuthenticationError(t, error, 4)
})

test('authentication error when non numeric return code is passed', async (t) => {
  t.plan(8)
  const error = new Error('Auth error')
  error.returnCode = 'return Code'
  await testAuthenticationError(t, error, 5)
})

test('authorize publish', async (t) => {
  t.plan(4)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  const s = await createAndConnect(t)

  s.broker.authorizePublish = (client, packet, cb) => {
    t.assert.ok(client, 'client exists')
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
    cb()
  }

  const packet = await new Promise((resolve) => {
    s.broker.mq.on('hello', (packet, cb) => {
      resolve(packet)
      cb()
    })
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })

  t.assert.equal(Object.hasOwn(packet, 'messageId'), false, 'should not contain messageId in QoS 0')
  expected.brokerId = s.broker.id
  expected.brokerCounter = s.broker.counter
  expected.clientId = 'my-client'
  delete expected.length
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches again')
})

test('authorize waits for authenticate', async (t) => {
  t.plan(6)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  broker.authenticate = (client, username, password, cb) => {
    t.assert.equal(client instanceof Client, true, 'client is there')
    // process.nextTick(() => {
    t.assert.equal(username, 'my username', 'username is there')
    t.assert.equal(password.toString(), 'my pass', 'password is there')
    client.authenticated = true
    cb(null, true)
    // })
  }

  broker.authorizePublish = (client, _packet, cb) => {
    t.assert.equal(client.authenticated, true, 'client authenticated')
    cb()
  }

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false,
    clientId: 'my-client'
  }

  await new Promise((resolve) => {
    s.broker.mq.on('hello', (packet, cb) => {
      t.assert.equal(Object.hasOwn(packet, 'messageId'), false, 'should not contain messageId in QoS 0')
      expected.brokerId = s.broker.id
      expected.brokerCounter = s.broker.counter
      delete expected.length
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches again')
      cb()
      resolve()
    })

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client',
      username: 'my username',
      password: 'my pass',
      keepalive: 0
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
})

test('authorize publish from configOptions', async (t) => {
  t.plan(4)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  const broker = await Aedes.createBroker({
    authorizePublish: (client, packet, cb) => {
      t.assert.ok(client, 'client exists')
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
      cb()
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)
  await connect(s)

  await new Promise((resolve) => {
    broker.mq.on('hello', (packet, cb) => {
      t.assert.equal(Object.hasOwn(packet, 'messageId'), false, 'should not contain messageId in QoS 0')
      expected.brokerId = s.broker.id
      expected.brokerCounter = s.broker.counter
      delete expected.length
      delete packet.clientId
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches again')
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

test('do not authorize publish', async (t) => {
  t.plan(3)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  const s = await createAndConnect(t)

  s.broker.authorizePublish = (client, packet, cb) => {
    t.assert.ok(client, 'client exists')
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
    cb(new Error('auth negated'))
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
  await once(s.broker, 'clientError')
  t.assert.equal(s.broker.connectedClients, 0, 'no connected clients')
})

test('modify qos out of range in authorize publish ', async (t) => {
  t.plan(3)

  const expected = {
    cmd: 'publish',
    topic: 'foo',
    payload: Buffer.from('bar'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false,
    clientId: 'my-client-xyz-4'
  }

  const s = await createAndConnect(t, { connect: { clientId: 'my-client-xyz-4' } })

  s.broker.authorizePublish = (client, packet, cb) => {
    if (packet.topic === 'hello') { packet.qos = 10 }
    cb()
  }

  s.broker.mq.on('hello', (packet, cb) => {
    t.assert.fail('should not publish')
  })

  await new Promise((resolve) => {
    s.broker.mq.on('foo', (packet, cb) => {
      t.assert.equal(Object.hasOwn(packet, 'messageId'), false, 'should not contain messageId in QoS 0')
      expected.brokerId = s.broker.id
      expected.brokerCounter = s.broker.counter
      delete expected.length
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
      resolve()
      cb()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
    s.inStream.write({
      cmd: 'publish',
      topic: 'foo',
      payload: 'bar'
    })
  })
  const result = await nextPacketWithTimeOut(s, 1)
  t.assert.equal(result, null, 'no packet')
})

test('authorize subscribe', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    t.assert.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, sub)
  }

  await subscribe(t, s, 'hello', 0)
})

test('authorize subscribe multiple same topics with same qos', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, sub)
  }

  await subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'hello', qos: 0 }], [0])
})

test('authorize subscribe multiple same topics with different qos', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.deepEqual(sub, {
      topic: 'hello',
      qos: 1
    }, 'topic matches')
    cb(null, sub)
  }

  await subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'hello', qos: 1 }], [1])
})

test('authorize subscribe multiple different topics', async (t) => {
  t.plan(7)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      t.assert.deepEqual(sub, {
        topic: 'hello',
        qos: 0
      }, 'topic matches')
    } else if (sub.topic === 'foo') {
      t.assert.deepEqual(sub, {
        topic: 'foo',
        qos: 0
      }, 'topic matches')
    }
    cb(null, sub)
  }

  await subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'foo', qos: 0 }], [0, 0])
})

test('authorize subscribe from config options', async (t) => {
  t.plan(5)
  const broker = await Aedes.createBroker({
    authorizeSubscribe: (client, sub, cb) => {
      t.assert.ok(client, 'client exists')
      t.assert.deepEqual(sub, {
        topic: 'hello',
        qos: 0
      }, 'topic matches')
      cb(null, sub)
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)
  await connect(s)
  await subscribe(t, s, 'hello', 0)
})

test('negate subscription', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    t.assert.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, null)
  }

  await subscribe(t, s, 'hello', 128)
})

test('negate multiple subscriptions', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    cb(null, null)
  }

  const expectedSubs = [{
    topic: 'hello',
    qos: 128
  }, {
    topic: 'world',
    qos: 128
  }]

  s.broker.once('subscribe', (subs, client) => {
    t.assert.deepEqual(subs, expectedSubs)
  })

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }, {
      topic: 'world',
      qos: 0
    }]
  })

  const packet = await nextPacket(s)
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(packet.granted, [128, 128])
  t.assert.equal(packet.messageId, 24)
})

test('negate subscription with correct persistence', async (t) => {
  t.plan(6)

  // rh, rap, nl are undefined because mqtt.parser is set to MQTT 3.1.1 and will thus erase these props from s.inStream.write
  const expected = [{
    topic: 'hello',
    qos: 0,
    rh: undefined,
    rap: undefined,
    nl: undefined
  }, {
    topic: 'world',
    qos: 0,
    rh: undefined,
    rap: undefined,
    nl: undefined
  }]

  const s = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      sub = null
    }
    cb(null, sub)
  }

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 0,
      rh: 0,
      rap: true,
      nl: false
    }, {
      topic: 'world',
      qos: 0,
      rh: 0,
      rap: true,
      nl: false
    }]
  })

  const packet = await nextPacket(s)
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(packet.granted, [128, 0])
  const subs = await s.broker.persistence.subscriptionsByClient(s.broker.clients.abcde)
  t.assert.deepEqual(subs, expected)
  t.assert.equal(packet.messageId, 24)
})

test('negate multiple subscriptions random times', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)
  // mock timers automatically disables at end of test
  t.mock.timers.enable({ apis: ['setTimeout'] })

  s.broker.authorizeSubscribe = (client, sub, cb) => {
    t.assert.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      setTimeout(() => {
        cb(null, sub)
      }, 100)
    } else {
      cb(null, null)
      t.mock.timers.tick(100)
    }
  }

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }, {
      topic: 'world',
      qos: 0
    }]
  })

  const packet = await nextPacket(s)
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(packet.granted, [0, 128])
  t.assert.equal(packet.messageId, 24)
})

test('failed authentication does not disconnect other client with same clientId', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)
  const s0 = setup(broker)

  broker.authenticate = (client, username, password, cb) => {
    cb(null, password.toString() === 'right')
  }

  await connect(s0, { connect: { password: 'right' } })
  const packet = await connect(s, { connect: { password: 'wrong' }, verifyReturnedOk: false })
  t.assert.deepEqual(packet, {
    cmd: 'connack',
    returnCode: 5,
    length: 2,
    qos: 0,
    retain: false,
    dup: false,
    topic: null,
    payload: null,
    sessionPresent: false
  }, 'unsuccessful connack')
  t.assert.equal(broker.connectedClients, 1, 'only one client connected')
  await once(s.conn, 'close')
  t.assert.equal(s0.conn.closed, false, 's0 is still connected')
  t.assert.equal(s.conn.closed, true, 's has been disconnected')
})

test('unauthorized connection should not unregister the correct one with same clientId', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, callback) => {
      if (username === 'correct') {
        callback(null, true)
      } else {
        const error = new Error()
        error.returnCode = 4
        callback(error, false)
      }
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)
  const s0 = setup(broker)

  const catchClientError = new Promise(resolve => {
    broker.on('clientError', (client, err) => {
      t.assert.equal(err.message, 'bad user name or password')
      t.assert.equal(err.errorCode, 4)
      t.assert.equal(broker.connectedClients, 1, 'my-client still connected')
      resolve()
    })
  })
  const serialConnect = async () => {
    await connect(s0, { connect: { username: 'correct' } })
    await connect(s, { connect: { username: 'unauthorized' }, expectedReturnCode: 4 })
  }
  await Promise.all([
    catchClientError,
    serialConnect()
  ])
})

test('set authentication method in config options', async (t) => {
  t.plan(6)

  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, cb) => {
      t.assert.equal(client instanceof Client, true, 'client is there')
      t.assert.equal(username, 'my username', 'username is there')
      t.assert.deepEqual(password, Buffer.from('my pass'), 'password is there')
      cb(null, false)
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)
  const packet = await connect(s, { verifyReturnedOk: false })

  t.assert.deepEqual(packet, {
    cmd: 'connack',
    returnCode: 5,
    length: 2,
    qos: 0,
    retain: false,
    dup: false,
    topic: null,
    payload: null,
    sessionPresent: false
  }, 'unsuccessful connack')
  t.assert.equal(s.broker.connectedClients, 0, 'no connected clients')
  await once(s.conn, 'close')
  t.assert.equal(s.conn.closed, true, 's has been disconnected')
})

test('change a topic name inside authorizeForward method in QoS 1 mode', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker({
    authorizeForward: (client, packet) => {
      packet.payload = Buffer.from('another-world')
      packet.messageId = 2
      return packet
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('another-world'),
    dup: false,
    length: 22,
    qos: 1,
    retain: false,
    messageId: 2
  }

  const publishedOk = new Promise((resolve) => {
    broker.on('client', (client) => {
      client.subscribe({
        topic: 'hello',
        qos: 1
      }, (err) => {
        t.assert.equal(err, undefined, 'no error')

        broker.publish({
          topic: 'hello',
          payload: Buffer.from('world'),
          qos: 1
        }, (err) => {
          t.assert.equal(err, undefined, 'no error')
          resolve()
        })
      })
    })
  })

  await Promise.all([
    publishedOk,
    connect(s)
  ])
  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

for (const cleanSession of [true, false]) {
  test(`unauthorized forward publish in QoS 1 mode [clean=${cleanSession}]`, async (t) => {
    t.plan(3)

    const broker = await Aedes.createBroker({
      authorizeForward: (_client, _packet) => {
        return null
      }
    })
    t.after(() => broker.close())
    const s = setup(broker)

    const publishedOk = new Promise((resolve) => {
      broker.on('client', (client) => {
        client.subscribe({
          topic: 'hello',
          qos: 1
        }, (err) => {
          t.assert.equal(err, undefined, 'no error')
          broker.publish({
            topic: 'hello',
            payload: Buffer.from('world'),
            qos: 1
          }, (err) => {
            t.assert.equal(err, undefined, 'no error')
            resolve()
          })
        })
      })
    })
    await Promise.all([
      publishedOk,
      connect(s, { connect: { clean: cleanSession } })
    ])
    const packet = await nextPacketWithTimeOut(s, 1)
    t.assert.equal(packet, null, 'no packet')
  })
}

test('prevent publish in QoS 0 mode', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker({
    authorizeForward: (client, packet) => {
      return null
    }
  })
  t.after(() => broker.close())
  const s = setup(broker)

  const publishedOk = new Promise((resolve) => {
    broker.on('client', (client) => {
      client.subscribe({
        topic: 'hello',
        qos: 1
      }, (err) => {
        t.assert.equal(err, undefined, 'no error')
        broker.publish({
          topic: 'hello',
          payload: Buffer.from('world'),
          qos: 1
        }, (err) => {
          t.assert.equal(err, undefined, 'no error')
          resolve()
        })
      })
    })
  })
  await Promise.all([
    publishedOk,
    connect(s)
  ])
  const packet = await nextPacketWithTimeOut(s, 1)
  t.assert.equal(packet, null, 'no packet')
})
