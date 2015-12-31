'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

test('publish QoS 1', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'puback',
    messageId: 42,
    qos: 0,
    dup: false,
    length: 2,
    retain: false
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, expected, 'packet must match')
    t.end()
  })
})

test('subscribe QoS 1', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.outStream.once('data', function (packet) {
      subscriber.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      t.notEqual(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })
  })
})

test('subscribe QoS 0, but publish QoS 1', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })
  })
})

test('restore QoS 1 subscriptions not clean', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
      t.equal(connect.sessionPresent, true, 'session present is set to true')
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world',
        qos: 1,
        messageId: 42
      })
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')
    })

    subscriber.outStream.once('data', function (packet) {
      subscriber.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      t.notEqual(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })
  })
})

test('remove stored subscriptions if connected with clean=true', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' }, function (packet) {
      t.equal(packet.sessionPresent, false, 'session present is set to false')
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world',
        qos: 1,
        messageId: 42
      })

      subscriber.inStream.end()

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
        t.equal(connect.sessionPresent, false, 'session present is set to false')
        publisher.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world',
          qos: 1,
          messageId: 43
        })

        t.end()
      })

      subscriber.outStream.once('data', function (packet) {
        t.fail('publish received')
      })
    })

    subscriber.outStream.once('data', function (packet) {
      t.fail('publish received')
    })
  })
})

test('resend publish on non-clean reconnect QoS 1', function (t) {
  var broker = aedes()
  var publisher
  var opts = { clean: false, clientId: 'abcde' }
  var subscriber = connect(setup(broker), opts)
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')

      subscriber = connect(setup(broker), opts)

      subscriber.outStream.once('data', function (packet) {
        subscriber.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
        t.end()
      })
    })
  })
})

test('do not resend QoS 1 packets at each reconnect', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

      subscriber.outStream.once('data', function (packet) {
        subscriber.inStream.end({
          cmd: 'puback',
          messageId: packet.messageId
        })

        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')

        var subscriber2 = connect(setup(broker), { clean: false, clientId: 'abcde' })

        subscriber2.outStream.once('data', function (packet) {
          t.fail('this should never happen')
        })

        // TODO wait all packets to be sent
        setTimeout(function () {
          t.end()
        }, 50)
      })
    })
  })
})

test('do not resend QoS 1 packets if reconnect is clean', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')

      subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' })

      subscriber.outStream.once('data', function (packet) {
        t.fail('this should never happen')
      })

      // TODO wait all packets to be sent
      setTimeout(function () {
        t.end()
      }, 50)
    })
  })
})

test('do not resend QoS 1 packets at reconnect if puback was received', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 1, function () {
    publisher = connect(setup(broker))

    publisher.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })

    publisher.outStream.once('data', function (packet) {
      t.equal(packet.cmd, 'puback')
    })

    subscriber.outStream.once('data', function (packet) {
      subscriber.inStream.end({
        cmd: 'puback',
        messageId: packet.messageId
      })

      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

      subscriber.outStream.once('data', function (packet) {
        t.fail('this should never happen')
      })

      // TODO wait all packets to be sent
      setTimeout(function () {
        t.end()
      }, 50)
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
    payload: new Buffer('world'),
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
        subscriber.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
        t.end()
      })
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
    payload: new Buffer('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: true
  }

  broker.mq.on('hello', function (msg, cb) {
    cb()

    subscribe(t, subscriber, 'hello', 1, function () {
      subscriber.outStream.once('data', function (packet) {
        t.deepEqual(packet, expected, 'packet must match')
        t.end()
      })
    })
  })

  publisher.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    messageId: 42,
    retain: true
  })
})
