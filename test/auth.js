'use strict'

const { test } = require('tap')
const eos = require('end-of-stream')
const Faketimers = require('@sinonjs/fake-timers')
const Client = require('../lib/client')
const { setup, connect, noError, subscribe, subscribeMultiple } = require('./helper')
const aedes = require('../')

test('authenticate successfully a client with username and password', function (t) {
  t.plan(4)

  const s = noError(setup())
  t.tearDown(s.broker.close.bind(s.broker))

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

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    cb(null, false)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.errorCode, 5)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
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
    }, 'unsuccessful connack, unauthorized')
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    cb(new Error('this should happen!'))
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'this should happen!')
    t.equal(err.errorCode, 5)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
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
    }, 'unsuccessful connack, unauthorized')
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 1
    cb(error, null)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Auth error')
    t.equal(err.errorCode, 5)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
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
    }, 'unsuccessful connack, unauthorized')
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 2
    cb(error, null)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Auth error')
    t.equal(err.errorCode, 2)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
  })

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
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 3
    cb(error, null)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Auth error')
    t.equal(err.errorCode, 3)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
  })

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
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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

test('authentication error when return code 4 (bad user or password) is passed', function (t) {
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Auth error')
    error.returnCode = 4
    cb(error, null)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Auth error')
    t.equal(err.errorCode, 4)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
  })

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
    }, 'unsuccessful connack, bad username or password')
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(7)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, Buffer.from('my pass'), 'password is there')
    var error = new Error('Non numeric error codes')
    error.returnCode = 'return Code'
    cb(error, null)
  }

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Non numeric error codes')
    t.equal(err.errorCode, 5)
  })

  s.broker.on('clientReady', function (client) {
    t.fail('client should not ready')
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
    }, 'unsuccessful connack, unauthorized')
  })

  eos(s.outStream, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
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
  t.plan(4)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

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
    t.notOk(Object.prototype.hasOwnProperty.call(packet, 'messageId'), 'should not contain messageId in QoS 0')
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
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

test('authorize waits for authenticate', function (t) {
  t.plan(6)

  const s = setup()
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    process.nextTick(function () {
      t.equal(username, 'my username', 'username is there')
      t.deepEqual(password, Buffer.from('my pass'), 'password is there')
      client.authenticated = true
      cb(null, true)
    })
  }

  s.broker.authorizePublish = function (client, packet, cb) {
    t.ok(client.authenticated, 'client authenticated')
    cb()
  }

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
    t.notOk(Object.prototype.hasOwnProperty.call(packet, 'messageId'), 'should not contain messageId in QoS 0')
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    delete expected.length
    t.deepEqual(packet, expected, 'packet matches')
    cb()
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

test('authorize publish from configOptions', function (t) {
  t.plan(4)

  const s = connect(setup(aedes({
    authorizePublish: function (client, packet, cb) {
      t.ok(client, 'client exists')
      t.deepEqual(packet, expected, 'packet matches')
      cb()
    }
  })))
  t.tearDown(s.broker.close.bind(s.broker))

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
    t.notOk(Object.prototype.hasOwnProperty.call(packet, 'messageId'), 'should not contain messageId in QoS 0')
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
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

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  const expected = {
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
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('authorize subscribe', function (t) {
  t.plan(5)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

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

test('authorize subscribe multiple same topics with same qos', function (t) {
  t.plan(4)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.deepEqual(sub, {
      topic: 'hello',
      qos: 0
    }, 'topic matches')
    cb(null, sub)
  }

  subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'hello', qos: 0 }], [0])
})

test('authorize subscribe multiple same topics with different qos', function (t) {
  t.plan(4)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.deepEqual(sub, {
      topic: 'hello',
      qos: 1
    }, 'topic matches')
    cb(null, sub)
  }

  subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'hello', qos: 1 }], [1])
})

test('authorize subscribe multiple different topics', function (t) {
  t.plan(7)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      t.deepEqual(sub, {
        topic: 'hello',
        qos: 0
      }, 'topic matches')
    } else if (sub.topic === 'foo') {
      t.deepEqual(sub, {
        topic: 'foo',
        qos: 0
      }, 'topic matches')
    }
    cb(null, sub)
  }

  subscribeMultiple(t, s, [{ topic: 'hello', qos: 0 }, { topic: 'foo', qos: 0 }], [0, 0])
})

test('authorize subscribe from config options', function (t) {
  t.plan(5)

  const s = connect(setup(aedes({
    authorizeSubscribe: function (client, sub, cb) {
      t.ok(client, 'client exists')
      t.deepEqual(sub, {
        topic: 'hello',
        qos: 0
      }, 'topic matches')
      cb(null, sub)
    }
  })))
  t.tearDown(s.broker.close.bind(s.broker))

  subscribe(t, s, 'hello', 0)
})

test('negate subscription', function (t) {
  t.plan(5)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

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

test('negate multiple subscriptions', function (t) {
  t.plan(5)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    cb(null, null)
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

  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [128, 128])
    t.equal(packet.messageId, 24)
  })
})

test('negate subscription with correct persistence', function (t) {
  t.plan(6)

  const expected = [{
    topic: 'hello',
    qos: 0
  }, {
    topic: 'world',
    qos: 0
  }]

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      sub = null
    }
    cb(null, sub)
  }

  const s = connect(setup(broker), { clean: false, clientId: 'abcde' })
  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [128, 0])
    broker.persistence.subscriptionsByClient(broker.clients.abcde, function (_, subs, client) {
      t.deepEqual(subs, expected)
    })
    t.equal(packet.messageId, 24)
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
})

test('negate multiple subscriptions random times', function (t) {
  t.plan(5)

  const clock = Faketimers.createClock()
  const s = connect(setup())
  t.tearDown(function () {
    clock.reset()
    s.broker.close()
  })

  s.broker.authorizeSubscribe = function (client, sub, cb) {
    t.ok(client, 'client exists')
    if (sub.topic === 'hello') {
      clock.setTimeout(function () {
        cb(null, sub)
      }, 100)
    } else {
      cb(null, null)
      clock.tick(100)
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

  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [0, 128])
    t.equal(packet.messageId, 24)
  })
})

test('failed authentication does not disconnect other client with same clientId', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)
  const s0 = setup(broker)

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

  const removeEos = eos(s0.outStream, function () {
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

test('unauthorized connection should not unregister the correct one with same clientId', function (t) {
  t.plan(4)

  const broker = aedes({
    authenticate: function (client, username, password, callback) {
      if (username === 'correct') {
        callback(null, true)
      } else {
        const error = new Error()
        error.returnCode = 4
        callback(error, false)
      }
    }
  })
  t.tearDown(broker.close.bind(broker))

  broker.on('clientError', function (client, err) {
    t.equal(err.message, 'bad user name or password')
    t.equal(err.errorCode, 4)
    t.equal(broker.connectedClients, 1, 'my-client still connected')
  })

  connect(setup(broker), {
    clientId: 'my-client',
    username: 'correct'
  }, function () {
    t.equal(broker.connectedClients, 1, 'my-client connected')
    connect(setup(broker), {
      clientId: 'my-client',
      username: 'unauthorized'
    }, function () {
      // other unauthorized connection with the same clientId should not unregister the correct one.
      t.fail('unauthorized should not connect')
    })
  })
})

test('set authentication method in config options', function (t) {
  t.plan(5)

  const s = setup(aedes({
    authenticate: function (client, username, password, cb) {
      t.ok(client instanceof Client, 'client is there')
      t.equal(username, 'my username', 'username is there')
      t.deepEqual(password, Buffer.from('my pass'), 'password is there')
      cb(null, false)
    }
  }))
  t.tearDown(s.broker.close.bind(s.broker))

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

  const broker = aedes({
    authorizeForward: function (client, packet) {
      packet.payload = Buffer.from('another-world')
      packet.messageId = 2
      return packet
    }
  })
  t.tearDown(broker.close.bind(broker))

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

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

;[true, false].forEach(function (cleanSession) {
  test(`unauthorized forward publish in QoS 1 mode [clean=${cleanSession}]`, function (t) {
    t.plan(2)

    const broker = aedes({
      authorizeForward: function (client, packet) {
        return null
      }
    })
    t.tearDown(broker.close.bind(broker))

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

    const s = connect(setup(broker), { clean: cleanSession })

    s.outStream.once('data', function (packet) {
      t.fail('Should have not recieved this packet')
    })
  })
})

test('prevent publish in QoS 0 mode', function (t) {
  t.plan(2)

  const broker = aedes({
    authorizeForward: function (client, packet) {
      return null
    }
  })
  t.tearDown(broker.close.bind(broker))

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

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.fail('Should have not recieved this packet')
  })
})
