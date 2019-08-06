'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

test('topics are case-sensitive', function (t) {
  t.plan(4)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  var subscriber = connect(setup(broker, false), { clean: true })
  var expected = {
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
  broker.on('closed', t.end.bind(t))
})

function subscribeMultipleTopics (t, broker, qos, subscriber, subscriptions, done) {
  var publisher = connect(setup(broker, false))
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

  var broker = aedes()
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 20,
    retain: false
  }
  var sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  subscribeMultipleTopics(t, broker, 1, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 0 publish', function (t) {
  t.plan(4)

  var broker = aedes()
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  var sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  subscribeMultipleTopics(t, broker, 0, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.3.5-1]
test('deliver overlapped topics respecting the maximum QoS of all the matching subscriptions - QoS 2 publish', function (t) {
  t.plan(3)

  var broker = aedes()
  var subscriber = connect(setup(broker))

  var sub = [
    { topic: 'hello/world', qos: 0 },
    { topic: 'hello/#', qos: 2 }]
  subscribeMultipleTopics(t, broker, 2, subscriber, sub, function () {
    subscriber.outStream.on('data', function () {
      t.fail('should receive messages with the maximum QoS')
    })
  })
  broker.on('closed', t.end.bind(t))
})

test('Overlapped topics with QoS downgrade', function (t) {
  t.plan(4)

  var broker = aedes()
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 18,
    retain: false
  }
  var sub = [
    { topic: 'hello/world', qos: 1 },
    { topic: 'hello/#', qos: 1 }]
  subscribeMultipleTopics(t, broker, 0, subscriber, sub, function () {
    subscriber.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})
