'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var Client = require('../lib/client')
var helper = require('./helper')
var aedes = require('../')
var eos = require('end-of-stream')
var setup = helper.setup
var subscribe = helper.subscribe
var connect = helper.connect

test('authenticate successfully a client with username and password', function (t) {
  t.plan(4)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    cb(null, true)
  }

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

test('authenticate unsuccessfully a client with username and password', function (t) {
  t.plan(6)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    cb(null, false)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
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
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
    t.pass('ended')
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
})

test('authenticate errors', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    cb(new Error('this should happen!'))
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 4,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack')
  })

  eos(s.outStream, function () {
    t.pass('ended')
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
})

test('authentication error when return code 1 (unacceptable protocol version) is passed', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 1
    cb(error, null)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 1,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack,unacceptable protocol version')
  })

  eos(s.outStream, function () {
    t.pass('ended')
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
})

test('authentication error when return code 2 (identifier rejected) is passed', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 2
    cb(error, null)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 2,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack, identifier rejected')
  })

  eos(s.outStream, function () {
    t.pass('ended')
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
})

test('authentication error when return code 3 (Server unavailable) is passed', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 3
    cb(error, null)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 3,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack, Server unavailable')
  })

  eos(s.outStream, function () {
    t.pass('ended')
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
})

test('authentication error when non numeric return code is passed', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Non numeric error codes')
    error.returnCode = 'return Code'
    cb(error, null)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 4,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack, bad user name or password')
  })

  eos(s.outStream, function () {
    t.pass('ended')
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
})

test('authorize publish', function (t) {
  t.plan(3)

  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  s.broker.authorizePublish = function (client, packet, cb) {
    t.ok(client, 'client exists')
    t.deepEqual(packet, expected, 'packet matches')
    cb()
  }

  s.broker.mq.on('hello', function (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    expected.messageId = 0
    delete expected.dup
    delete expected.length
    t.deepEqual(packet, expected, 'packet matches')
    cb()
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('authorize publish from configOptions', function (t) {
  t.plan(3)

  var s = connect(setup(aedes({
    authorizePublish: function (client, packet, cb) {
      t.ok(client, 'client exists')
      t.deepEqual(packet, expected, 'packet matches')
      cb()
    }
  })))

  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  s.broker.mq.on('hello', function (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    expected.messageId = 0
    delete expected.dup
    delete expected.length
    t.deepEqual(packet, expected, 'packet matches')
    cb()
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('do not authorize publish', function (t) {
  t.plan(3)

  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }

  s.broker.authorizePublish = function (client, packet, cb) {
    t.ok(client, 'client exists')
    t.deepEqual(packet, expected, 'packet matches')
    cb(new Error('auth negated'))
  }

  eos(s.conn, function () {
    t.pass('ended')
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('authorize subscribe', function (t) {
  t.plan(5)

  var s = connect(setup())

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    t.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, sub)
  }

  subscribe(t, s, 'hello', 0)
})

test('authorize subscribe from config options', function (t) {
  t.plan(5)

  var s = connect(setup(aedes({
    authorizeSubscribe: function (client, sub, cb) {
      t.ok(client, 'client exists')
      t.deepEqual(sub, {
        topic: 'hello',
        qos: 0
      }, 'topic matches')
      cb(null, sub)
    }
  })))

  subscribe(t, s, 'hello', 0)
})

test('negate subscription', function (t) {
  t.plan(5)

  var s = connect(setup())

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    t.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, null)
  }

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }]
  })

  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [128])
    t.equal(packet.messageId, 24)
  })
})

test('failed authentication does not disconnect other client with same clientId', function (t) {
  t.plan(3)

  var broker = aedes()
  var s = setup(broker)
  var s0 = setup(broker)

  broker.authenticate = function (client, username, password, cb) {
    cb(null, password.toString() === 'right')
  }

  s0.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    username: 'my username',
    password: 'right',
    keepalive: 0
  })

  s0.outStream.on('data', function (packet) {
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

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client',
      username: 'my username',
      password: 'wrong',
      keepalive: 0
    })
  })

  var removeEos = eos(s0.outStream, function () {
    t.fail('ended before time')
  })

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
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
  })

  eos(s.outStream, function () {
    t.pass('ended')
    removeEos()
  })
})

test('set authentication method in config options', function (t) {
  t.plan(6)

  var s = setup(aedes({
    authenticate: function (client, username, password, cb) {
      t.ok(client instanceof Client, 'client is there')
      t.equal(username, 'my username', 'username is there')
      t.deepEqual(password, Buffer.from('my pass'), 'password is there')
      cb(null, false)
    }
  }))

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
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
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
    t.pass('ended')
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
})

test('change a topic name inside authorizeForward method in QoS 1 mode', function (t) {
  t.plan(3)

  var broker = aedes({
    authorizeForward: function (client, packet, cb) {
      packet.payload = Buffer.from('another-world')
      packet.messageId = 2
      return packet
    }
  })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('another-world'),
    dup: false,
    length: 22,
    qos: 1,
    retain: false,
    messageId: 2
  }

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 1
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 1
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('prevent publish in QoS1 mode', function (t) {
  t.plan(2)

  var broker = aedes({
    authorizeForward: function (client, packet, cb) {
      return null
    }
  })

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 1
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 1
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.fail('Should have not recieved this packet')
  })
})

test('prevent publish in QoS0 mode', function (t) {
  t.plan(2)

  var broker = aedes({
    authorizeForward: function (client, packet, cb) {
      return null
    }
  })

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.fail('Should have not recieved this packet')
  })
})
