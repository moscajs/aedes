'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var http = require('http')
var ws = require('websocket-stream')
var mqtt = require('mqtt')

;[{ ver: 3, id: 'MQIsdp' }, { ver: 4, id: 'MQTT' }].forEach(function (ele) {
  test('connect and connack (minimal)', function (t) {
    t.plan(1)

    var s = setup()

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
      t.end()
    })
  })
})

// [MQTT-3.1.2-2]
test('reject client requested for unacceptable protocol version', function (t) {
  t.plan(4)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'unacceptable protocol version')
  })
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject client requested for unsupported protocol version', function (t) {
  t.plan(2)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

// Guarded in mqtt-packet
test('reject clients with no clientId running on MQTT 3.1.0', function (t) {
  t.plan(2)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.1.3-7], Guarded in mqtt-packet
test('reject clients without clientid and clean=false on MQTT 3.1.1', function (t) {
  t.plan(2)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

test('clients without clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

test('clients with zero-byte clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', function () {
    t.end()
  })
})

// [MQTT-3.1.3-7]
test('reject clients with > 23 clientId length in MQTT 3.1.0', function (t) {
  t.plan(4)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

test('connect with > 23 clientId length in MQTT 3.1.1', function (t) {
  t.plan(3)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.1.0-1]
test('the first Packet MUST be a CONNECT Packet', function (t) {
  t.plan(2)

  var broker = aedes()
  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }
  var s = setup(broker, false)
  s.inStream.write(packet)

  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocol')
  })
  setImmediate(() => {
    t.ok(s.conn.destroyed, 'close connection if first packet is not a CONNECT')
    s.conn.destroy()
    broker.close()
    t.end()
  })
})

// [MQTT-3.1.0-2]
test('second CONNECT Packet sent from a Client as a protocol violation and disconnect the Client', function (t) {
  t.plan(4)

  var broker = aedes()
  var packet = {
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
  var s = connect(setup(broker, false), { clientId: 'abcde' }, function () {
    t.ok(broker.clients.abcde.connected)
    // destory client when there is a 2nd cmd:connect, even the clientId is dfferent
    s.inStream.write(packet)
    setImmediate(() => {
      t.equal(broker.clients.abcde, undefined, 'client instance is removed')
      t.ok(s.conn.destroyed, 'close connection if packet is a CONNECT after network is established')
      broker.close()
      t.end()
    })
  })
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject clients with wrong protocol name', function (t) {
  t.plan(2)

  var broker = aedes()
  var s = setup(broker)

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
  broker.on('closed', t.end.bind(t))
})

;[[0, null, false], [1, null, true], [1, new Error('connection banned'), false], [1, new Error('connection banned'), true]].forEach(function (ele) {
  var plan = ele[0]
  var err = ele[1]
  var ok = ele[2]
  test('preConnect handler', function (t) {
    t.plan(plan)

    var broker = aedes({
      preConnect: function (client, done) {
        return done(err, ok)
      }
    })
    var s = setup(broker)

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client',
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
    broker.on('closed', t.end.bind(t))
  })
})

// websocket-stream based connections
test('websocket clients have access to the request object', function (t) {
  t.plan(3)

  var broker = aedes()
  var server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(4883, function (err) {
    t.error(err, 'no error')
  })

  broker.on('client', function (client) {
    if (client.req) {
      t.pass('client request object present')
      if (client.req.headers) {
        t.equal('sample', client.req.headers['x-test-protocol'])
        finish()
      }
    } else {
      t.fail('no request object present')
    }
  })

  var client = mqtt.connect('ws://localhost:4883', {
    wsOptions: {
      headers: {
        'X-Test-Protocol': 'sample'
      }
    }
  })

  var timer = setTimeout(finish, 1000)

  function finish () {
    clearTimeout(timer)
    broker.close()
    server.close()
    client.end()
    t.end()
  }
})
