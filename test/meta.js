'use strict'

const { test } = require('tap')
const { setup, connect, subscribe, noError } = require('./helper')
const aedes = require('../')

test('count connected clients', function (t) {
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  t.equal(broker.connectedClients, 0, 'no connected clients')

  connect(setup(broker), {
  }, function () {
    t.equal(broker.connectedClients, 1, 'one connected clients')

    const last = connect(setup(broker), {
    }, function () {
      t.equal(broker.connectedClients, 2, 'two connected clients')

      last.conn.destroy()

      // needed because destroy() will do the trick before
      // the next tick
      setImmediate(function () {
        t.equal(broker.connectedClients, 1, 'one connected clients')
      })
    })
  })
})

test('call published method', function (t) {
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.published = function (packet, client, done) {
    t.equal(packet.topic, 'hello', 'topic matches')
    t.equal(packet.payload.toString(), 'world', 'payload matches')
    t.equal(client, null, 'no client')
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
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.published = function (packet, client, done) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
      t.equal(packet.qos, 1)
      t.equal(packet.messageId, 42)
      done()
    }
  }

  const s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    messageId: 42
  })
})

test('emit publish event with client - QoS 0', function (t) {
  t.plan(3)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('publish', function (packet, client) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.qos, 0)
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
    }
  })

  const s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0
  })
})

test('emit publish event with client - QoS 1', function (t) {
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('publish', function (packet, client) {
    // for internal messages, client will be null
    if (client) {
      t.equal(packet.qos, 1)
      t.equal(packet.messageId, 42)
      t.equal(packet.topic, 'hello', 'topic matches')
      t.equal(packet.payload.toString(), 'world', 'payload matches')
    }
  })

  const s = connect(setup(broker))

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

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = connect(setup(broker), { clientId: 'abcde' })

  broker.on('subscribe', function (subscriptions, client) {
    t.same(subscriptions, [{
      topic: 'hello',
      qos: 0
    }], 'topic matches')
    t.equal(client.id, 'abcde', 'client matches')
  })

  subscribe(t, s, 'hello', 0, function () {
    t.pass('subscribe completed')
  })
})

test('emit subscribe event if unrecognized params in subscribe packet structure', function (t) {
  t.plan(3)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = noError(connect(setup(broker)))
  const subs = [{ topic: 'hello', qos: 0 }]

  broker.on('subscribe', function (subscriptions, client) {
    t.equal(subscriptions, subs)
    t.same(client, s.client)
  })

  s.client.subscribe({
    subscriptions: subs,
    restore: true
  }, function (err) {
    t.error(err)
  })
})

test('emit unsubscribe event', function (t) {
  t.plan(6)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = connect(setup(broker), { clean: true, clientId: 'abcde' })

  broker.on('unsubscribe', function (unsubscriptions, client) {
    t.same(unsubscriptions, [
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

test('emit unsubscribe event if unrecognized params in unsubscribe packet structure', function (t) {
  t.plan(3)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = noError(connect(setup(broker)))
  const unsubs = [{ topic: 'hello', qos: 0 }]

  broker.on('unsubscribe', function (unsubscriptions, client) {
    t.equal(unsubscriptions, unsubs)
    t.same(client, s.client)
  })

  s.client.unsubscribe({
    unsubscriptions: unsubs,
    close: true
  }, function (err) {
    t.error(err)
  })
})

test('dont emit unsubscribe event on client close', function (t) {
  t.plan(3)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = noError(connect(setup(broker), { clientId: 'abcde' }), t)

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

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('clientDisconnect', function (client) {
    t.equal(client.id, 'abcde', 'client matches')
  })

  const s = noError(connect(setup(broker), { clientId: 'abcde' }), t)

  s.inStream.end({
    cmd: 'disconnect'
  })
  s.outStream.resume()
})

test('emits client', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('client', function (client) {
    t.equal(client.id, 'abcde', 'clientId matches')
  })

  connect(setup(broker), {
    clientId: 'abcde'
  })
})

test('get aedes version', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  t.equal(broker.version, require('../package.json').version)
})

test('connect and connackSent event', { timeout: 50 }, function (t) {
  t.plan(3)

  const s = setup()
  t.teardown(s.broker.close.bind(s.broker))

  const clientId = 'my-client'

  s.broker.on('connackSent', function (packet, client) {
    t.equal(packet.returnCode, 0)
    t.equal(client.id, clientId, 'connackSent event and clientId matches')
  })

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId,
    keepalive: 0
  })

  s.outStream.on('data', function (packet) {
    t.same(packet, {
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
