'use strict'

const { test } = require('tap')
const { setup, connect, subscribe } = require('./helper')
const aedes = require('../')

// [MQTT-4.7.1-3]
test('Single-level wildcard should match empty level', function (t) {
  t.plan(4)

  var s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  subscribe(t, s, 'a/+/b', 0, function () {
    s.outStream.once('data', function (packet) {
      t.pass('ok')
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'a//b',
      payload: 'world'
    })
  })
})

// [MQTT-4.7.3-1]
test('publish empty topic', function (t) {
  t.plan(4)

  const s = connect(setup())

  subscribe(t, s, '#', 0, function () {
    s.outStream.once('data', function (packet) {
      t.fail('no packet')
    })

    s.inStream.write({
      cmd: 'publish',
      topic: '',
      payload: 'world'
    })

    s.broker.close(function () {
      t.equal(s.broker.connectedClients, 0, 'no connected clients')
    })
  })
})

test('publish invalid topic with #', function (t) {
  t.plan(4)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  subscribe(t, s, '#', 0, function () {
    s.outStream.once('data', function (packet) {
      t.fail('no packet')
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello/#',
      payload: 'world'
    })
  })

  s.broker.on('clientError', function () {
    t.pass('raise an error')
  })
})

test('publish invalid topic with +', function (t) {
  t.plan(4)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  subscribe(t, s, '#', 0, function () {
    s.outStream.once('data', function (packet) {
      t.fail('no packet')
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello/+/eee',
      payload: 'world'
    })
  })

  s.broker.on('clientError', function () {
    t.pass('raise an error')
  })
})

;['base/#/sub', 'base/#sub', 'base/sub#', 'base/xyz+/sub', 'base/+xyz/sub', ''].forEach(function (topic) {
  test('subscribe to invalid topic with "' + topic + '"', function (t) {
    t.plan(1)

    const s = connect(setup())
    t.tearDown(s.broker.close.bind(s.broker))

    s.broker.on('clientError', function () {
      t.pass('raise an error')
    })

    s.inStream.write({
      cmd: 'subscribe',
      messageId: 24,
      subscriptions: [{
        topic: topic,
        qos: 0
      }]
    })
  })

  test('unsubscribe to invalid topic with "' + topic + '"', function (t) {
    t.plan(1)

    const s = connect(setup())
    t.tearDown(s.broker.close.bind(s.broker))

    s.broker.on('clientError', function () {
      t.pass('raise an error')
    })

    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 24,
      unsubscriptions: [topic]
    })
  })
})

test('topics are case-sensitive', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: true })
  const subscriber = connect(setup(broker), { clean: true })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet mush match')
    })
    ;['hello', 'HELLO', 'heLLo', 'HELLO/#', 'hello/+'].forEach(function (topic) {
      publisher.inStream.write({
        cmd: 'publish',
        topic: topic,
        payload: 'world',
        qos: 0,
        retain: false
      })
    })
  })
})

function subscribeMultipleTopics (t, broker, qos, subscriber, subscriptions, done) {
  const publisher = connect(setup(broker))
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: subscriptions
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, subscriptions.map(obj => obj.qos))
    t.equal(packet.messageId, 24)

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello/world',
      payload: 'world',
      qos: qos,
      messageId: 42
    })

    if (done) {
      done(null, packet)
    }
  })
}

test('Overlapped topics with same QoS', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const subscriber = connect(setup(broker))
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 20,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  subscribeMultipleTopics(t, broker, 1, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 0 publish', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const subscriber = connect(setup(broker))
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  subscribeMultipleTopics(t, broker, 0, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 2 publish', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const subscriber = connect(setup(broker))

  const sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  subscribeMultipleTopics(t, broker, 2, subscriber, sub, function () {
    subscriber.outStream.on('data', function () {
      t.fail('should receive messages with the maximum QoS')
    })
  })
})

test('Overlapped topics with QoS downgrade', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const subscriber = connect(setup(broker))
  const expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  const sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  subscribeMultipleTopics(t, broker, 0, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})
