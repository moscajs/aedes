'use strict'

const { test } = require('tap')
const http = require('http')
const ws = require('websocket-stream')
const mqtt = require('mqtt')
const { setup, connect, delay } = require('./helper')
const aedes = require('../')

;[{ ver: 3, id: 'MQIsdp' }, { ver: 4, id: 'MQTT' }].forEach(function (ele) {
  test('connect and connack (minimal)', function (t) {
    t.plan(1)

    const s = setup()
    t.tearDown(s.broker.close.bind(s.broker))

    s.inStream.write({
      cmd: 'connect',
      protocolId: ele.id,
      protocolVersion: ele.ver,
      clean: true,
      clientId: 'my-client',
      keepalive: 0
    })

    s.outStream.on('data', function (packet) {
      t.deepEqual(packet, {
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
  })
})

// [MQTT-3.1.2-2]
test('reject client requested for unacceptable protocol version', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 5,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 1, 'unacceptable protocol version')
    t.equal(broker.connectedClients, 0)
  })
  broker.on('clientError', function (client, err) {
    t.fail('should not raise clientError error')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'unacceptable protocol version')
  })
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject client requested for unsupported protocol version', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 2,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocol version')
    t.equal(broker.connectedClients, 0)
  })
})

// Guarded in mqtt-packet
test('reject clients with no clientId running on MQTT 3.1.0', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: true,
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'clientId must be supplied before 3.1.1')
    t.equal(broker.connectedClients, 0)
  })
})

// [MQTT-3.1.3-7], Guarded in mqtt-packet
test('reject clients without clientid and clean=false on MQTT 3.1.1', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: false,
    clientId: '',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'clientId must be given if cleanSession set to 0')
    t.equal(broker.connectedClients, 0)
  })
})

test('clients without clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
  broker.on('client', function (client) {
    t.ok(client.id.startsWith('aedes_'))
  })
})

test('clients with zero-byte clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: '',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
  broker.on('client', function (client) {
    t.ok(client.id.startsWith('aedes_'))
  })
})

// [MQTT-3.1.3-7]
test('reject clients with > 23 clientId length in MQTT 3.1.0', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: true,
    clientId: 'abcdefghijklmnopqrstuvwxyz',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 2, 'identifier rejected')
    t.equal(broker.connectedClients, 0)
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'identifier rejected')
  })
})

test('connect with > 23 clientId length in MQTT 3.1.1', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcdefghijklmnopqrstuvwxyz',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
})

// [MQTT-3.1.0-1]
test('the first Packet MUST be a CONNECT Packet', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }
  const s = setup(broker)
  s.inStream.write(packet)

  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocol')
  })
  setImmediate(() => {
    t.ok(s.conn.destroyed, 'close connection if first packet is not a CONNECT')
    s.conn.destroy()
  })
})

// [MQTT-3.1.0-2]
test('second CONNECT Packet sent from a Client as a protocol violation and disconnect the Client', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  }
  broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Invalid protocol')
  })
  const s = connect(setup(broker), { clientId: 'abcde' }, function () {
    t.ok(broker.clients.abcde.connected)
    // destory client when there is a 2nd cmd:connect, even the clientId is dfferent
    s.inStream.write(packet)
    setImmediate(() => {
      t.equal(broker.clients.abcde, undefined, 'client instance is removed')
      t.ok(s.conn.destroyed, 'close connection if packet is a CONNECT after network is established')
    })
  })
})

test('reject second CONNECT Packet sent while first CONNECT still in preConnect stage', function (t) {
  t.plan(2)

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

  var i = 0
  const broker = aedes({
    preConnect: function (client, done) {
      var ms = i++ === 0 ? 2000 : 500
      setTimeout(function () {
        done(null, true)
      }, ms)
    }
  })
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  broker.on('connectionError', function (client, err) {
    t.equal(err.info.clientId, 'my-client-2')
    t.equal(err.message, 'Invalid protocol')
  })

  const msg = async (s, ms, msg) => {
    await delay(ms)
    s.inStream.write(msg)
  }

  ;(async () => {
    await Promise.all([msg(s, 100, packet1), msg(s, 200, packet2)])
  })().catch(
    (error) => {
      t.fail(error)
    }
  )
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject clients with wrong protocol name', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT_hello',
    protocolVersion: 3,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocolId')
    t.equal(broker.connectedClients, 0)
  })
})

test('After first CONNECT Packet, others are queued until \'connect\' event', function (t) {
  t.plan(2)

  const queueLimit = 50
  const broker = aedes({ queueLimit })
  t.tearDown(broker.close.bind(broker))

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
  s.inStream.write(connectP)

  process.once('warning', e => t.fail('Memory leak detected'))

  for (let i = 0; i < queueLimit; i++) {
    s.inStream.write(publishP)
  }

  broker.on('client', function (client) {
    t.equal(client._parser._queue.length, queueLimit, 'Packets have been queued')

    client.once('connected', () => {
      t.equal(client._parser._queue, null, 'Queue is empty')
      s.conn.destroy()
    })
  })
})

test('Test queue limit', function (t) {
  t.plan(1)

  const queueLimit = 50
  const broker = aedes({ queueLimit })
  t.tearDown(broker.close.bind(broker))

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
  s.inStream.write(connectP)

  process.once('warning', e => t.fail('Memory leak detected'))

  for (let i = 0; i < queueLimit + 1; i++) {
    s.inStream.write(publishP)
  }

  broker.on('connectionError', function (conn, err) {
    t.equal(err.message, 'Client queue limit reached', 'Queue error is thrown')
    s.conn.destroy()
  })
})

;[[0, null, false], [0, null, true], [1, new Error('connection banned'), false], [1, new Error('connection banned'), true]].forEach(function (ele, idx) {
  const plan = ele[0]
  const err = ele[1]
  const ok = ele[2]
  test('preConnect handler', function (t) {
    t.plan(plan)

    const broker = aedes({
      preConnect: function (client, done) {
        return done(err, ok)
      }
    })
    t.tearDown(broker.close.bind(broker))

    const s = setup(broker)

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client-' + idx,
      keepalive: 0
    })
    broker.on('client', function (client) {
      if (ok) {
        t.pass('connect ok')
      } else {
        t.fail('no reach here')
      }
    })
    broker.on('clientError', function (client, err) {
      t.fail('no client error')
    })
    broker.on('connectionError', function (client, err) {
      if (err) {
        t.equal(err.message, 'connection banned')
      } else {
        t.fail('no connection error')
      }
    })
  })
})

// websocket-stream based connections
test('websocket clients have access to the request object', function (t) {
  t.plan(3)

  const port = 4883
  const broker = aedes()
  broker.on('client', function (client) {
    if (client.req) {
      t.pass('client request object present')
      if (client.req.headers) {
        t.equal('sample', client.req.headers['x-test-protocol'])
      }
    } else {
      t.fail('no request object present')
    }
  })

  const server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect(`ws://localhost:${port}`, {
    wsOptions: {
      headers: {
        'X-Test-Protocol': 'sample'
      }
    }
  })

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})
