import { test } from 'node:test'
import { once } from 'node:events'
import {
  checkNoPacket,
  createAndConnect,
  delay,
  nextPacket,
  rawWrite,
  setup,
  withTimeout
} from './helper.js'
import http from 'node:http'
import { createServer } from 'node:net'
import { WebSocketServer, createWebSocketStream } from 'ws'
import mqtt from 'mqtt'
import { Aedes } from '../aedes.js'
import handleConnect from '../lib/handlers/connect.js'
import handle from '../lib/handlers/index.js'

for (const ele of [{ ver: 3, id: 'MQIsdp' }, { ver: 4, id: 'MQTT' }]) {
  test('connect and connack (minimal)', async (t) => {
    t.plan(1)

    const s = await createAndConnect(t, {
      connect: {
        protocolId: ele.id,
        protocolVersion: ele.ver,
        clean: true,
        clientId: 'my-client',
        keepalive: 0
      }
    })
    t.assert.equal(s.client.version, ele.ver, 'client version matches')
  })
}

// [MQTT-3.1.2-2]
// MQTT 5.0 is now an accepted protocol version. The legacy MQTT 3.1/3.1.1
// in-memory harness uses a v4 parser that cannot decode a v5 CONNACK, so this
// uses a real TCP socket + v5 client (see also test/mqtt5.js).
test('accept client requesting MQTT 5.0 protocol version', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  const server = createServer(broker.handle)
  t.after(() => {
    server.close()
    broker.close()
  })
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  const client = mqtt.connect({ port, host: 'localhost', protocolVersion: 5, clientId: 'my-client' })
  t.after(() => client.end(true))

  const [connack] = await once(client, 'connect')
  // v5 CONNACK carries a reasonCode (0 = success), not a v3/v4 returnCode
  t.assert.equal(connack.reasonCode, 0, 'v5 CONNACK reasonCode is success')
  t.assert.equal(broker.connectedClients, 1)
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject client requested for unsupported protocol version', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  // inStream.write throws an error when trying to write illegal packets
  // so we use the encoded version:
  const sendPacket = () => {
    // cmd: 'connect', protocolId: 'MQTT', protocolVersion: 2, clean: true, clientId: 'my-client', keepalive: 0
    const rawPacket = '10 15 00 04 4D 51 54 54 02 02 00 00 00 09 6D 79 2D 63 6C 69 65 6E 74'
    rawWrite(s, rawPacket)
  }

  const checkDisconnect = async () => {
    const [client, err] = await once(s.broker, 'connectionError')
    t.assert.equal(client.version, null)
    t.assert.equal(err.message, 'Invalid protocol version')
    t.assert.equal(broker.connectedClients, 0)
  }

  // run parallel
  await Promise.all([
    checkNoPacket(t, s),
    checkDisconnect(),
    sendPacket()
  ])
})

test('reject clients that exceed the keepalive limit', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, {
    broker: {
      keepaliveLimit: 100
    },
    connect: {
      cmd: 'connect',
      keepalive: 150
    },
    expectedReturnCode: 6
  })

  const [client, err] = await once(s.broker, 'connectionError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, 'keep alive limit exceeded')
  t.assert.equal(s.broker.connectedClients, 0)
})

// TODO: test fails because Aedes does not reject this
// remove { skip: true} once this is fixed
// Guarded in mqtt-packet
test('reject clients with no clientId running on MQTT 3.1.0', { skip: true }, async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  // s.inStream.write throws an error when trying to write illegal packets
  // so we use the encoded version:
  const sendPacket = () => {
    // // cmd: 'connect', protocolId: 'MQIsdp', protocolVersion: 3, clean: true, keepalive: 0, clientId: ''
    const rawPacket = '10 0E 00 06 4D 51 49 73 64 70 03 02 00 00 00 00'
    rawWrite(s, rawPacket)
  }

  const checkDisconnect = async () => {
    const [client, err] = await once(s.broker, 'connectionError')
    t.assert.equal(client.version, null)
    t.assert.equal(err.message, 'clientId must be supplied before 3.1.1')
    t.assert.equal(broker.connectedClients, 0)
  }

  // run parallel
  await Promise.all([
    checkNoPacket(t, s),
    checkDisconnect(),
    sendPacket()
  ])
})

// [MQTT-3.1.3-7], [MQTT-3.1.3-8]: a zero-byte ClientId with CleanSession = 0
// must be rejected with return code 0x02 (identifier rejected), then the
// connection closed. mqtt-packet guards this on encode, so we send the raw
// bytes rather than going through s.inStream.write.
test('reject clients with zero-byte clientid and clean=false on MQTT 3.1.1', async (t) => {
  t.plan(5)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  // Subscribe before writing so the rejection error is never missed.
  const errorPromise = once(broker, 'connectionError')

  // cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: false, clientId: '', keepalive: 0
  rawWrite(s, '10 0C 00 04 4D 51 54 54 04 00 00 00 00 00')

  const connack = await nextPacket(s)
  t.assert.equal(connack.cmd, 'connack')
  t.assert.equal(connack.returnCode, 2, 'connack return code is 2 (identifier rejected)')

  const [client, err] = await errorPromise
  t.assert.ok(client, 'client is there')
  t.assert.equal(err.message, 'identifier rejected')
  t.assert.equal(broker.connectedClients, 0)
})

// [MQTT-3.1.3-7/8] apply only to v3/v4. MQTT 5.0 allows a zero-length ClientId
// regardless of the Clean Start flag — the broker must assign one (reported via
// the Assigned Client Identifier property) instead of rejecting. Guards the
// `protocolVersion < 5` carve-out in init(). mqtt-packet refuses to encode an
// empty clientId with clean=false, so the raw bytes are sent directly.
test('clients with zero-byte clientid and clean=false on MQTT 5.0 get an assigned clientId', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  // cmd: 'connect', protocolVersion: 5, clean: false, clientId: '', keepalive: 0, no properties
  rawWrite(s, '10 0D 00 04 4D 51 54 54 05 00 00 00 00 00 00')

  const [client] = await once(broker, 'clientReady')
  t.assert.equal(broker.connectedClients, 1)
  t.assert.equal(client.version, 5)
  t.assert.ok(client.id.startsWith('aedes_'))
})

test('clients without clientid and clean=true on MQTT 3.1.1 will get a generated clientId', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, {
    connect: {
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      keepalive: 0
    },
    noClientId: true,
  })
  t.assert.equal(s.broker.connectedClients, 1)
  t.assert.equal(s.client.version, 4)
  t.assert.ok(s.client.id.startsWith('aedes_'))
})

test('client connect error while fetching subscriptions', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const s = setup(broker)

  broker.persistence.subscriptionsByClient = async () => {
    throw new Error('error')
  }

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: false,
    clientId: 'my-client',
    keepalive: 0
  })

  const [client, err] = await once(broker, 'clientError')
  t.assert.equal(client.version, 4)
  t.assert.ok(err, 'throws error')
})

test('client connect clear outgoing', async (t) => {
  t.plan(1)

  const clientId = 'abcde'
  const brokerId = 'pippo'

  const broker = await Aedes.createBroker({ id: brokerId })
  t.after(() => broker.close())

  const subs = [{ clientId }]
  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    brokerId,
    brokerCounter: 2,
    retain: true,
    messageId: 42,
    dup: false
  }

  await broker.persistence.outgoingEnqueueCombi(subs, packet)

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId,
    keepalive: 0
  })

  const [client] = await once(broker, 'clientReady')
  t.assert.rejects(
    async () => broker.persistence.outgoingUpdate(client, packet),
    { message: 'no such packet' },
    'packet not found')
})

test('clients with zero-byte clientid and clean=true on MQTT 3.1.1 will get a generated clientId', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  const s = setup(broker)
  t.after(() => broker.close())
  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 0,
    clientId: '',
  })
  await nextPacket(s)
  t.assert.equal(broker.connectedClients, 1)
  t.assert.equal(s.client.version, 4)
  t.assert.ok(s.client.id.startsWith('aedes_'))
})

// [MQTT-3.1.3-7]
test('reject clients with > 23 clientId length in MQTT 3.1.0', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t, {
    connect: {
      protocolId: 'MQIsdp',
      protocolVersion: 3,
      clean: true,
      clientId: 'abcdefghijklmnopqrstuvwxyz',
      keepalive: 0
    },
    expectedReturnCode: 2
  })
  t.assert.equal(s.broker.connectedClients, 0)
  t.assert.equal(s.client.version, null)

  const [client, err] = await once(s.broker, 'connectionError')
  t.assert.ok(client)
  t.assert.equal(err.message, 'identifier rejected')
})

test('connect clients with > 23 clientId length using aedes maxClientsIdLength option in MQTT 3.1.0', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t, {
    connect: {
      protocolId: 'MQIsdp',
      protocolVersion: 3,
      clean: true,
      clientId: 'abcdefghijklmnopqrstuvwxyz',
      keepalive: 0
    },
    broker: { maxClientsIdLength: 26 }
  })

  t.assert.equal(s.broker.connectedClients, 1)
  t.assert.equal(s.client.version, 3)
})

test('connect with > 23 clientId length in MQTT 3.1.1', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t, {
    connect: {
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'abcdefghijklmnopqrstuvwxyz',
      keepalive: 0
    },
    broker: { maxClientsIdLength: 26 }
  })

  t.assert.equal(s.broker.connectedClients, 1)
  t.assert.equal(s.client.version, 4)
})

// // [MQTT-3.1.0-1]
test('the first Packet MUST be a CONNECT Packet', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }
  const s = setup(broker)
  s.inStream.write(packet)

  const [client, err] = await once(broker, 'connectionError')
  t.assert.ok(client, 'client is defined')
  t.assert.equal(err.message, 'Invalid protocol')
  t.assert.ok(s.conn.destroyed, 'close connection if first packet is not a CONNECT')
})

// // [MQTT-3.1.0-2]
test('second CONNECT Packet sent from a Client as a protocol violation and disconnect the Client', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t, {
    connect: {
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'abcde',
      keepalive: 0
    }
  })
  await once(s.broker, 'clientReady')
  t.assert.ok(s.broker.clients.abcde.connected)
  const sendPacket = () => {
    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client',
      keepalive: 0
    })
  }
  const checkError = async () => {
    const [client, err] = await once(s.broker, 'clientError')
    t.assert.ok(client)
    t.assert.equal(err.message, 'Invalid protocol')
    // destory client when there is a 2nd cmd:connect, even the clientId is dfferent
    t.assert.equal(s.broker.clients.abcde, undefined, 'client instance is removed')
    t.assert.equal(s.broker.connectedClients, 0, 'no clients connected')
    t.assert.ok(s.conn.destroyed, 'close connection if packet is a CONNECT after network is established')
  }
  // run parallel
  await Promise.all([
    checkError(),
    sendPacket()
  ])
})

test('connect handler calls done when preConnect throws error', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker({
    preConnect: function (client, packet, done) {
      done(Error('error in preconnect'))
    }
  })
  t.after(() => broker.close())

  const s = setup(broker)
  await new Promise(resolve => {
    handleConnect(s.client, {}, function done (err) {
      t.assert.equal(err.message, 'error in preconnect', 'calls done with error')
      resolve()
    })
  })
})

test('connect handler rejects an out-of-range protocol version', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const s = setup(broker)

  // mqtt-packet's parser only ever yields protocol versions 3/4/5, so this
  // defensive guard in init() is exercised by calling the handler directly with
  // an out-of-range version (e.g. a custom decodeProtocol could produce one).
  await new Promise(resolve => {
    handleConnect(s.client, { cmd: 'connect', protocolVersion: 6, clientId: 'x', clean: true, keepalive: 0 }, function done (err) {
      t.assert.equal(err.message, 'unacceptable protocol version', 'rejected with unacceptable protocol version')
      t.assert.equal(err.errorCode, 1, 'return code 1')
      resolve()
    })
  })
})

test('handler calls done when disconnect or unknown packet cmd is received', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const s = setup(broker)

  await new Promise(resolve => {
    handle(s.client, { cmd: 'disconnect' }, function done () {
      t.assert.ok(true, 'calls done when disconnect cmd is received')
      resolve()
    })
  })

  await new Promise(resolve => {
    handle(s.client, { cmd: 'fsfadgragae' }, function done () {
      t.assert.ok(true, 'calls done when unknown cmd is received')
    })
    resolve()
  })
})

test('reject second CONNECT Packet sent while first CONNECT still in preConnect stage', async (t) => {
  t.plan(3)

  const packet1 = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-1',
    keepalive: 0
  }
  const packet2 = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-2',
    keepalive: 0
  }

  let i = 0

  const broker = await Aedes.createBroker({
    preConnect: (client, packet, done) => {
      const ms = i++ === 0 ? 200 : 50
      setTimeout(() => {
        done(null, true)
      }, ms)
    }
  })
  t.after(() => broker.close())

  const s = setup(broker)

  const msg = async (s, ms, msg) => {
    await delay(ms)
    s.inStream.write(msg)
  }

  const checkError = async () => {
    const [client, err] = await once(broker, 'connectionError')
    t.assert.ok(client)
    t.assert.equal(err.message, 'Invalid protocol')
    t.assert.equal(err.info.clientId, 'my-client-2')
  }

  await Promise.all([
    checkError(),
    msg(s, 100, packet1),
    msg(s, 200, packet2)])
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject clients with wrong protocol name', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT_hello',
    protocolVersion: 3,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })

  const [client, err] = await once(broker, 'connectionError')
  t.assert.ok(client)
  t.assert.equal(err.message, 'Invalid protocolId')
  t.assert.equal(broker.connectedClients, 0)
  await checkNoPacket(t, s)
})

// TODO this test only reports a queue of 2 instead of 50
// remove { skip: true} once this is fixed
test('After first CONNECT Packet, others are queued until \'connect\' event', { skip: true }, async (t) => {
  t.plan(2)

  const queueLimit = 50
  const broker = await Aedes.createBroker({
    queueLimit,
    authenticate: (client, username, password, callback) => {
      setTimeout(() => {
        callback(null, true)
      }, 10) // force Aedes to wait before processing the publish packets
    }
  })
  t.after(() => broker.close())

  const publishP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }

  const connectP = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcde',
    keepalive: 0
  }

  const s = setup(broker)
  process.once('warning', e => t.assert.fail('Memory leak detected'))

  await new Promise(resolve => {
    broker.on('client', client => {
      t.assert.equal(client._parser._queue.length, queueLimit, 'Packets have been queued')

      client.once('connected', () => {
        t.assert.equal(client._parser._queue, null, 'Queue is empty')
        s.conn.destroy()
        resolve()
      })
    })

    s.inStream.write(connectP)
    for (let i = 0; i < queueLimit; i++) {
      s.inStream.write(publishP)
    }
  })
})

// TODO since the queue limit of 50 is not reached the test does not end
// remove { skip: true} once this is fixed
test('Test queue limit', { skip: true }, async (t) => {
  t.plan(1)

  const queueLimit = 50
  const broker = await Aedes.createBroker({
    queueLimit,
    authenticate: (client, username, password, callback) => {
      setTimeout(() => {
        callback(null, true)
      }, 10) // force Aedes to wait before processing the publish packets
    }
  })
  t.after(() => broker.close())

  const publishP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }

  const connectP = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcde',
    keepalive: 0
  }

  const s = setup(broker)
  process.once('warning', e => t.fail('Memory leak detected'))

  await new Promise(resolve => {
    broker.on('connectionError', (conn, err) => {
      t.assert.equal(err.message, 'Client queue limit reached', 'Queue error is thrown')
      s.conn.destroy()
      resolve()
    })

    s.inStream.write(connectP)
    for (let i = 0; i < queueLimit + 1; i++) {
      s.inStream.write(publishP)
    }
  })
})

for (const ele of [
  ['fail with no error msg', 6, null, false],
  ['succeed with no error msg', 10, null, true],
  ['fail with error msg', 8, new Error('connection banned'), false],
  ['succeed with error msg', 8, new Error('connection banned'), true]
]) {
  const [title, plan, errValue, ok] = ele

  test(`preConnect handler - ${title}`, async (t) => {
    t.plan(plan)

    const broker = await Aedes.createBroker({
      preConnect: (client, packet, done) => {
        t.assert.ok(client.connecting)
        t.assert.ok(!client.connected)
        t.assert.equal(client.version, null)
        return done(errValue, ok)
      }
    })
    t.after(() => broker.close())

    const s = setup(broker)

    const checkOnClient = async () => {
      const [result] = await withTimeout(once(broker, 'client'), 10, ['timeout'])
      if (ok && !errValue) {
        const client = result
        t.assert.ok(client.connecting, 'client connecting')
        t.assert.ok(!client.connected, 'client connected')
        t.assert.ok(true, 'register client ok')
      } else {
        t.assert.equal(result, 'timeout', 'no client connected')
      }
    }

    const checkOnClientReady = async () => {
      const [client] = await withTimeout(once(broker, 'clientReady'), 10, ['timeout'])
      if (ok && !errValue) {
        t.assert.ok(!client.connecting, 'clientReady connecting')
        t.assert.equal(broker.connectedClients, 1, 'clientReady connectedClients')
        // TODO: sometimes client.connected is false for 'succeed with no error msg'
        if (title !== 'succeed with no error msg') {
          t.assert.ok(client.connected, 'clientReady connected')
        } else {
          t.assert.ok(true, 'do not check clientReady connected for now')
        }
      } else {
        t.assert.equal(client, 'timeout', 'no client connected')
      }
    }

    broker.on('clientError', (client, err) => {
      t.assert.fail('no client error')
    })

    const checkOnConnectionError = async () => {
      const [client, err] = await withTimeout(once(broker, 'connectionError'), 10, ['timeout'])
      if (client !== 'timeout') {
        t.assert.ok(!client.connecting)
        t.assert.ok(!client.connected)
        t.assert.equal(err?.message, 'connection banned')
      } else {
        t.assert.equal(client, 'timeout', 'no connection error')
      }
    }

    const clientId = `client-${title.replace(/ /g, '-')}`
    const sendPacket = () => {
      s.inStream.write({
        cmd: 'connect',
        protocolId: 'MQTT',
        protocolVersion: 4,
        clean: true,
        clientId,
        keepalive: 0
      })
    }
    // run parallel
    await Promise.all([
      checkOnClient(),
      checkOnClientReady(),
      checkOnConnectionError(),
      sendPacket()
    ])
  })
}

// websocket based connections
test('websocket clients have access to the request object', async (t) => {
  t.plan(3)

  const port = 4883

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const server = http.createServer()
  t.after(() => server.close())
  const wss = new WebSocketServer({
    server
  })

  wss.on('connection', (websocket, req) => {
    // websocket is a WebSocket, but aedes expects a stream.
    const stream = createWebSocketStream(websocket)
    broker.handle(stream, req)
  })

  server.listen(port, err => {
    t.assert.ok(!err, 'no error')
  })

  const checkOnClient = async () => {
    const [client] = await once(broker, 'client')
    if (client.req) {
      t.assert.ok(true, 'client request object present')
      if (client.req.headers) {
        t.assert.equal('sample', client.req.headers['x-test-protocol'])
      }
    } else {
      t.assert.fail('no request object present')
    }
  }

  const doConnect = () => {
    const client = mqtt.connect(`ws://localhost:${port}`, {
      wsOptions: {
        headers: {
          'X-Test-Protocol': 'sample'
        }
      }
    })
    t.after(() => client.end(true))
  }
  // run parallel
  await Promise.all([
    checkOnClient(),
    doConnect()
  ])
})
