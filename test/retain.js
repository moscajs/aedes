'use strict'

const { test } = require('tap')
const { through } = require('../lib/utils')
const Faketimers = require('@sinonjs/fake-timers')
const { setup, connect, subscribe, noError } = require('./helper')
const aedes = require('../')

// [MQTT-3.3.1-9]
test('live retain packets', function (t) {
  t.plan(5)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    retain: false,
    dup: false,
    length: 12,
    qos: 0
  }

  const s = noError(connect(setup()), t)
  t.tearDown(s.broker.close.bind(s.broker))

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
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const expected = {
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
        })
      })
    })
  })

  publisher.inStream.write(expected)
})

test('avoid wrong deduping of retain messages', function (t) {
  t.plan(7)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const expected = {
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
          })
        })
      })
    })
  })

  publisher.inStream.write(expected)
})

test('reconnected subscriber will not receive retained messages when QoS 0 and clean', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: true })
  var subscriber = connect(setup(broker), { clean: true })
  const expected = {
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
      subscriber = connect(setup(broker), { clean: true })
      subscriber.outStream.on('data', function (packet) {
        t.fail('should not received retain message')
      })
    })
  })
})

// [MQTT-3.3.1-6]
test('new QoS 0 subscribers receive QoS 0 retained messages when clean', function (t) {
  t.plan(9)

  const clock = Faketimers.createClock()
  const broker = aedes()
  t.tearDown(function () {
    clock.reset()
    broker.close()
  })

  const publisher = connect(setup(broker), { clean: true })
  const expected = {
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
  const subscriber1 = connect(setup(broker), { clean: true })
  subscribe(t, subscriber1, 'hello/world', 0, function () {
    subscriber1.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
      clock.tick(100)
    })
  })
  const subscriber2 = connect(setup(broker), { clean: true })
  subscribe(t, subscriber2, 'hello/+', 0, function () {
    subscriber2.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
      clock.tick(100)
    })
  })

  clock.setTimeout(() => {
    t.equal(broker.counter, 8)
  }, 200)
})

// [MQTT-3.3.1-5]
test('new QoS 0 subscribers receive downgraded QoS 1 retained messages when clean', function (t) {
  t.plan(6)

  const broker = aedes()

  const publisher = connect(setup(broker), { clean: true })
  const expected = {
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
    qos: 1,
    retain: true,
    messageId: 42
  })
  publisher.outStream.on('data', function (packet) {
    const subscriber = connect(setup(broker), { clean: true })
    subscribe(t, subscriber, 'hello', 0, function () {
      subscriber.outStream.on('data', function (packet) {
        t.notEqual(packet.messageId, 42, 'messageId should not be the same')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
        broker.close()
      })
    })
  })
  broker.on('closed', function () {
    t.equal(broker.counter, 7)
  })
})

// [MQTT-3.3.1-10]
test('clean retained messages', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: true })
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
  const subscriber = connect(setup(broker), { clean: true })
  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.once('data', function (packet) {
      t.fail('should not received retain message')
    })
  })
})

// [MQTT-3.3.1-11]
test('broker not store zero-byte retained messages', function (t) {
  t.plan(0)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = connect(setup(broker))

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: '',
    retain: true
  })
  s.broker.on('publish', function (packet, client) {
    if (packet.topic.startsWith('$SYS/')) {
      return
    }
    const stream = s.broker.persistence.createRetainedStream(packet.topic)
    stream.pipe(through(function sendRetained (packet, enc, cb) {
      t.fail('not store zero-byte retained messages')
    }))
  })
})

test('fail to clean retained messages without retain flag', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: true })
  const expected = {
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
  const subscriber = connect(setup(broker), { clean: true })
  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})

test('only get the last retained messages in same topic', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: true })
  const expected = {
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
  const subscriber = connect(setup(broker), { clean: true })
  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})

test('deliver QoS 1 retained messages to new subscriptions', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
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
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
      })
    })
  })
})

test('deliver QoS 1 retained messages to established subscriptions', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const expected = {
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
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const expected = {
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

test('disconnect and retain messages with QoS 1 [clean=false]', function (t) {
  t.plan(7)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var subscriber = noError(connect(setup(broker), { clean: false, clientId: 'abcde' }), t)
  const expected = {
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

    const publisher = noError(connect(setup(broker)), t)

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

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
        t.equal(connect.sessionPresent, true, 'session present is set to true')
      })

      subscriber.outStream.once('data', function (packet) {
        // receive any queued messages (no matter they are retained messages) at the disconnected time
        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        packet.length = 14
        t.deepEqual(packet, expected, 'packet must match')

        // there should be no messages come from restored subscriptions
        subscriber.outStream.once('data', function (packet) {
          t.fail('should not receive any more messages')
        })
      })
    })
  })
})

test('disconnect and two retain messages with QoS 1 [clean=false]', function (t) {
  t.plan(15)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var subscriber = noError(connect(setup(broker), { clean: false, clientId: 'abcde' }), t)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
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

    const publisher = noError(connect(setup(broker)), t)

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 41,
      retain: true
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')

      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world2',
        qos: 1,
        messageId: 42,
        retain: true
      })

      publisher.outStream.once('data', function (packet) {
        t.equal(packet.cmd, 'puback')

        subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
          t.equal(connect.sessionPresent, true, 'session present is set to true')
        })

        subscriber.outStream.once('data', function (packet) {
          // receive any queued messages (included retained messages) at the disconnected time
          t.notEqual(packet.messageId, 41, 'messageId must differ')
          delete packet.messageId
          packet.length = 14
          expected.payload = Buffer.from('world')
          t.deepEqual(packet, expected, 'packet must match')

          // receive any queued messages (included retained messages) at the disconnected time
          subscriber.outStream.once('data', function (packet) {
            t.notEqual(packet.messageId, 42, 'messageId must differ')
            delete packet.messageId
            packet.length = 14
            expected.payload = Buffer.from('world2')
            t.deepEqual(packet, expected, 'packet must match')

            // should get the last retained message when we do a subscribe
            subscribe(t, subscriber, 'hello', 1, function () {
              subscriber.outStream.on('data', function (packet) {
                t.notEqual(packet.messageId, 42, 'messageId must differ')
                delete packet.messageId
                packet.length = 14
                expected.payload = Buffer.from('world2')
                t.deepEqual(packet, expected, 'packet must match')
              })
            })
          })
        })
      })
    })
  })
})
