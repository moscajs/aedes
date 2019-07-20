'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var noError = helper.noError
var subscribe = helper.subscribe

test('live retain packets', function (t) {
  t.plan(5)
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    retain: false,
    dup: false,
    length: 12,
    qos: 0
  }

  var s = noError(connect(setup()), t)

  subscribe(t, s, 'hello', 0, function () {
    s.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected)
    })

    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      retain: true,
      dup: false,
      length: 12,
      qos: 0
    }, function () {
      t.pass('publish finished')
    })
  })
})

test('retain messages', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  broker.subscribe('hello', function (packet, cb) {
    cb()

    // defer this or it will receive the message which
    // is being published
    setImmediate(function () {
      subscribe(t, subscriber, 'hello', 0, function () {
        subscriber.outStream.once('data', function (packet) {
          t.deepEqual(packet, expected, 'packet must match')
          t.end()
        })
      })
    })
  })

  publisher.inStream.write(expected)
})

test('avoid wrong deduping of retain messages', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  broker.subscribe('hello', function (packet, cb) {
    cb()
    // subscribe and publish another topic
    subscribe(t, subscriber, 'hello2', 0, function () {
      cb()

      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello2',
        payload: Buffer.from('world'),
        qos: 0,
        dup: false
      })

      subscriber.outStream.once('data', function (packet) {
        subscribe(t, subscriber, 'hello', 0, function () {
          subscriber.outStream.once('data', function (packet) {
            t.deepEqual(packet, expected, 'packet must match')
            t.end()
          })
        })
      })
    })
  })

  publisher.inStream.write(expected)
})

test('reconnected subscriber will not receive retained messages when QoS 0 and clean', function (t) {
  t.plan(4)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  var subscriber = connect(setup(broker, false), { clean: true })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false,
    length: 12
  }
  subscribe(t, subscriber, 'hello', 0, function () {
    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 0,
      retain: false
    })
    subscriber.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
      subscriber.inStream.end()
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'foo',
        qos: 0,
        retain: true
      })
      subscriber = connect(setup(broker, false), { clean: true })
      subscriber.outStream.on('data', function (packet) {
        t.fail('should not received retain message')
      })
    })
  })

  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.3.1-6]
test('new subscribers receive retained messages when QoS 0 and clean', function (t) {
  t.plan(8)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  var expected = {
    cmd: 'publish',
    topic: 'hello/world',
    payload: Buffer.from('big big world'),
    qos: 0,
    retain: true,
    dup: false,
    length: 26
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello/world',
    payload: 'big big world',
    qos: 0,
    retain: true
  })
  var subscriber1 = connect(setup(broker, false), { clean: true })
  subscribe(t, subscriber1, 'hello/world', 0, function () {
    subscriber1.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  var subscriber2 = connect(setup(broker, false), { clean: true })
  subscribe(t, subscriber2, 'hello/+', 0, function () {
    subscriber2.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})

// [MQTT-3.3.1-10]
test('clean retained messages', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    qos: 0,
    retain: true
  })
  var subscriber = connect(setup(broker, false), { clean: true })
  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.once('data', function (packet) {
      t.fail('should not received retain message')
    })
  })
  broker.on('closed', t.end.bind(t))
})

test('fail to clean retained messages without retain flag', function (t) {
  t.plan(4)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: true,
    dup: false,
    length: 12
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    qos: 0,
    retain: false
  })
  var subscriber1 = connect(setup(broker, false), { clean: true })
  subscribe(t, subscriber1, 'hello', 0, function () {
    subscriber1.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})

test('only get the last retained messages in same topic', function (t) {
  t.plan(4)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: true })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('foo'),
    qos: 0,
    retain: true,
    dup: false,
    length: 10
  }
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    retain: true
  })
  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'foo',
    qos: 0,
    retain: true
  })
  var subscriber1 = connect(setup(broker, false), { clean: true })
  subscribe(t, subscriber1, 'hello', 0, function () {
    subscriber1.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
  broker.on('closed', t.end.bind(t))
})

test('deliver QoS 1 retained messages', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42,
    retain: true
  })

  publisher.outStream.on('data', function (packet) {
    subscribe(t, subscriber, 'hello', 1, function () {
      subscriber.outStream.once('data', function (packet) {
        t.deepEqual(packet, expected, 'packet must match')
        t.end()
      })
    })
  })
})

test('deliver QoS 1 retained messages', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.outStream.once('data', function (packet) {
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })
    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42,
      retain: true
    })
  })
})

test('deliver QoS 0 retained message with QoS 1 subscription', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  broker.mq.on('hello', function (msg, cb) {
    cb()

    // defer this or it will receive the message which
    // is being published
    setImmediate(function () {
      subscribe(t, subscriber, 'hello', 1, function () {
        subscriber.outStream.once('data', function (packet) {
          t.deepEqual(packet, expected, 'packet must match')
          t.end()
        })
      })
    })
  })

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    messageId: 42,
    retain: true
  })
})

test('not clean and retain messages with QoS 1', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: true
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.write({
      cmd: 'disconnect'
    })

    subscriber.outStream.on('data', function (packet) {
      console.log('original', packet)
    })

    publisher = connect(setup(broker))

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42,
      retain: true
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')

      broker.on('clientError', function (client, err) {
        t.fail('no error')
      })

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
        t.equal(connect.sessionPresent, true, 'session present is set to true')
      })

      subscriber.outStream.once('data', function (packet) {
        t.notEqual(packet.messageId, 42, 'messageId must differ')
        t.equal(packet.qos, 0, 'qos degraded to 0 for retained')
        var prevId = packet.messageId
        delete packet.messageId
        packet.qos = 1
        packet.length = 14
        t.deepEqual(packet, expected, 'packet must match')

        // message is duplicated
        subscriber.outStream.once('data', function (packet2) {
          var curId = packet2.messageId
          t.notOk(curId === prevId, 'messageId must differ')
          subscriber.inStream.write({
            cmd: 'puback',
            messageId: curId
          })
          delete packet2.messageId
          t.deepEqual(packet, expected, 'packet must match')

          t.end()
        })
      })
    })
  })
})
