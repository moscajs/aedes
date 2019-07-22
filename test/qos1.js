'use strict'

var Buffer = require('safe-buffer').Buffer
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

test('publish QoS 1 and check offline queue', function (t) {
  t.plan(9)

  var broker = aedes()
  var publisher = connect(setup(broker), { clean: false })
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var subscriberClient = {
    id: 'abcde'
  }
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    retain: false,
    messageId: 1
  }
  var expectedAck = {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 1
  }
  var sent = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 1,
    retain: false
  }
  var queue = []
  subscribe(t, subscriber, 'hello', 1, function () {
    publisher.outStream.on('data', function (packet) {
      t.deepEqual(packet, expectedAck, 'ack packet must patch')
    })
    subscriber.outStream.on('data', function (packet) {
      queue.push(packet)
      delete packet.payload
      delete packet.length
      t.deepEqual(packet, expected, 'publish packet must patch')
      if (queue.length === 2) {
        setImmediate(() => {
          for (var i = 0; i < queue.length; i++) {
            broker.persistence.outgoingClearMessageId(subscriberClient, sent, function (_, origPacket) {
              if (origPacket) {
                delete origPacket.brokerId
                delete origPacket.brokerCounter
                delete origPacket.payload
                delete origPacket.length
                delete sent.payload
                t.deepEqual(origPacket, sent, 'origPacket must match')
              }
            })
          }
          t.end()
        })
      }
    })
    publisher.inStream.write(sent)
    sent.payload = 'world2world'
    publisher.inStream.write(sent)
  })
})

test('subscribe QoS 1', function (t) {
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
    payload: Buffer.from('world'),
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
    payload: Buffer.from('world'),
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
    payload: Buffer.from('world'),
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
    payload: Buffer.from('world'),
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
    payload: Buffer.from('world'),
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

test('remove stored subscriptions after unsubscribe', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })

    subscriber.outStream.once('data', function (packet) {
      t.deepEqual(packet, {
        cmd: 'unsuback',
        messageId: 43,
        dup: false,
        length: 2,
        qos: 0,
        retain: false
      }, 'packet matches')

      subscriber.inStream.end()

      publisher = connect(setup(broker))

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (packet) {
        t.equal(packet.sessionPresent, false, 'session present is set to false')
        publisher.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world',
          qos: 1,
          messageId: 42
        })

        publisher.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world',
          qos: 1,
          messageId: 43
        }, function () {
          subscriber.inStream.end()
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
})

test('upgrade a QoS 0 subscription to QoS 1', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    length: 14,
    retain: false,
    dup: false
  }

  subscribe(t, s, 'hello', 0, function () {
    subscribe(t, s, 'hello', 1, function () {
      s.outStream.once('data', function (packet) {
        t.ok(packet.messageId, 'has messageId')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet matches')
        t.end()
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world',
        qos: 1
      })
    })
  })
})

test('downgrade QoS 0 publish on QoS 1 subsciption', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    length: 12,
    retain: false,
    dup: false
  }

  subscribe(t, s, 'hello', 1, function () {
    s.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet matches')
      t.end()
    })
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 0
    })
  })
})

test('subscribe and publish QoS 1 in parallel', function (t) {
  t.plan(5)

  var broker = aedes()
  var s = connect(setup(broker))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  broker.on('clientError', function (client, err) {
    console.log(err.stack)
    // t.fail('no client error')
  })

  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'puback')
    t.equal(packet.messageId, 42, 'messageId must match')
    s.outStream.on('data', function (packet) {
      if (packet.cmd === 'suback') {
        t.deepEqual(packet.granted, [1])
        t.equal(packet.messageId, 24)
      }
      if (packet.cmd === 'publish') {
        s.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
      }
    })
  })

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 1
    }]
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })
})
