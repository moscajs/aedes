'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

test('count connected clients', function (t) {
  t.plan(4)

  var broker = aedes()

  t.equal(broker.connectedClients, 0, 'no connected clients')

  connect(setup(broker))

  process.nextTick(function () {
    t.equal(broker.connectedClients, 1, 'one connected clients')

    var last = connect(setup(broker))

    process.nextTick(function () {
      t.equal(broker.connectedClients, 2, 'two connected clients')

      last.conn.destroy()

      // needed because destroy() will do the trick before
      // the next tick
      process.nextTick(function () {
        t.equal(broker.connectedClients, 1, 'one connected clients')
      })
    })
  })
})

test('call published method', function (t) {
  t.plan(4)

  var broker = aedes()

  broker.published = function (packet, client, done) {
    t.equal(packet.topic, 'hello', 'topic matches')
    t.equal(packet.payload.toString(), 'world', 'payload matches')
    t.equal(client, null, 'no client')
    broker.close()
    done()
  }

  broker.publish({
    topic: 'hello',
    payload: Buffer.from('world')
  }, function (err) {
    t.error(err, 'no error')
  })
})

test('call published method with client', function (t) {
  t.plan(2)

  var broker = aedes()

  broker.published = function (packet, client, done) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
      broker.close()
      done()
    }
  }

  var s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world')
  })
})

test('emit publish event with client - QoS 0', function (t) {
  t.plan(3)

  var broker = aedes()

  broker.on('publish', function (packet, client) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.qos, 0)
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
      broker.close()
    }
  })

  var s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0
  })
})

test('emit publish event with client - QoS 1', function (t) {
  t.plan(4)

  var broker = aedes()

  broker.on('publish', function (packet, client) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.qos, 1)
      t.equal(packet.messageId, 42)
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
      broker.close()
    }
  })

  var s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    messageId: 42
  })
})

test('emit subscribe event', function (t) {
  t.plan(6)

  var broker = aedes()
  var s = connect(setup(broker), { clientId: 'abcde' })

  broker.on('subscribe', function (subscriptions, client) {
    t.deepEqual(subscriptions, [{
      topic: 'hello',
      qos: 0
    }], 'topic matches')
    t.equal(client.id, 'abcde', 'client matches')
  })

  subscribe(t, s, 'hello', 0, function () {
    t.pass('subscribe completed')
  })
})

test('emit unsubscribe event', function (t) {
  t.plan(6)

  var broker = aedes()
  var s = connect(setup(broker), { clean: true, clientId: 'abcde' })

  broker.on('unsubscribe', function (unsubscriptions, client) {
    t.deepEqual(unsubscriptions, [
      'hello'
    ], 'unsubscription matches')
    t.equal(client.id, 'abcde', 'client matches')
  })

  subscribe(t, s, 'hello', 0, function () {
    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })

    s.outStream.once('data', function (packet) {
      t.pass('subscribe completed')
    })
  })
})

test('dont emit unsubscribe event on client close', function (t) {
  t.plan(3)

  var broker = aedes()
  var s = connect(setup(broker), { clientId: 'abcde' })

  broker.on('unsubscribe', function (unsubscriptions, client) {
    t.error('unsubscribe should not be emitted')
  })

  subscribe(t, s, 'hello', 0, function () {
    s.inStream.end({
      cmd: 'disconnect'
    })
    s.outStream.once('data', function (packet) {
      t.pass('unsubscribe completed')
    })
  })
})

test('emit clientDisconnect event', function (t) {
  t.plan(1)

  var broker = aedes()

  broker.on('clientDisconnect', function (client) {
    t.equal(client.id, 'abcde', 'client matches')
  })

  var s = connect(setup(broker), { clientId: 'abcde' })

  s.inStream.end({
    cmd: 'disconnect'
  })
  s.outStream.resume()
})

test('emits client', function (t) {
  t.plan(1)

  var broker = aedes()

  broker.on('client', function (client) {
    t.equal(client.id, 'abcde', 'clientId matches')
  })

  connect(setup(broker), {
    clientId: 'abcde'
  })
})

test('get aedes version', function (t) {
  t.plan(1)

  var broker = aedes()
  t.equal(broker.version, require('../package.json').version)
  broker.close()
  t.end()
})

test('connect and connackSent event', function (t) {
  t.plan(3)
  t.timeoutAfter(50)

  var s = setup()
  var clientId = 'my-client'

  s.broker.on('connackSent', function (packet, client) {
    t.equal(packet.returnCode, 0)
    t.equal(client.id, clientId, 'connackSent event and clientId matches')
    t.end()
  })

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: clientId,
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
