'use strict'

const { test } = require('tap')
const concat = require('concat-stream')
const { setup, connect, subscribe } = require('./helper')
const Faketimers = require('@sinonjs/fake-timers')
const aedes = require('../')

test('publish QoS 1', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  const expected = {
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
    t.same(packet, expected, 'packet must match')
  })
})

test('publish QoS 1 throws error', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.persistence.subscriptionsByTopic = function (packet, done) {
    return done(new Error('Throws error'))
  }

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  s.broker.on('error', function (err) {
    t.equal('Throws error', err.message, 'Throws error')
  })
})

test('publish QoS 1 throws error on write', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('client', function (client) {
    client.connected = false
    client.connecting = false

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })
  })

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'connection closed', 'throws error')
  })
})

test('publish QoS 1 and check offline queue', function (t) {
  t.plan(13)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: false })
  const subscriberClient = {
    id: 'abcde'
  }
  const subscriber = connect(setup(broker), { clean: false, clientId: subscriberClient.id })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    retain: false
  }
  const expectedAck = {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 10
  }
  const sent = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 10,
    retain: false,
    dup: false
  }
  const queue = []
  subscribe(t, subscriber, 'hello', 1, function () {
    publisher.outStream.on('data', function (packet) {
      t.same(packet, expectedAck, 'ack packet must patch')
    })
    subscriber.outStream.on('data', function (packet) {
      queue.push(packet)
      delete packet.payload
      delete packet.length
      t.not(packet.messageId, undefined, 'messageId is assigned a value')
      t.not(packet.messageId, 10, 'messageId should be unique')
      expected.messageId = packet.messageId
      t.same(packet, expected, 'publish packet must patch')
      if (queue.length === 2) {
        setImmediate(() => {
          for (let i = 0; i < queue.length; i++) {
            broker.persistence.outgoingClearMessageId(subscriberClient, queue[i], function (_, origPacket) {
              if (origPacket) {
                delete origPacket.brokerId
                delete origPacket.brokerCounter
                delete origPacket.payload
                delete origPacket.messageId
                delete sent.payload
                delete sent.messageId
                t.same(origPacket, sent, 'origPacket must match')
              }
            })
          }
        })
      }
    })
    publisher.inStream.write(sent)
    sent.payload = 'world2world'
    publisher.inStream.write(sent)
  })
})

test('publish QoS 1 and empty offline queue', function (t) {
  t.plan(13)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const publisher = connect(setup(broker), { clean: false })
  const subscriberClient = {
    id: 'abcde'
  }
  const subscriber = connect(setup(broker), { clean: false, clientId: subscriberClient.id })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    qos: 1,
    dup: false,
    retain: false
  }
  const expectedAck = {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 10
  }
  const sent = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 10,
    retain: false,
    dup: false
  }
  const queue = []
  subscribe(t, subscriber, 'hello', 1, function () {
    publisher.outStream.on('data', function (packet) {
      t.same(packet, expectedAck, 'ack packet must patch')
    })
    subscriber.outStream.on('data', function (packet) {
      queue.push(packet)
      delete packet.payload
      delete packet.length
      t.not(packet.messageId, undefined, 'messageId is assigned a value')
      t.not(packet.messageId, 10, 'messageId should be unique')
      expected.messageId = packet.messageId
      t.same(packet, expected, 'publish packet must patch')
      if (queue.length === 2) {
        setImmediate(() => {
          broker.clients[subscriberClient.id].emptyOutgoingQueue(function () {
            for (let i = 0; i < queue.length; i++) {
              broker.persistence.outgoingClearMessageId(subscriberClient, queue[i], function (_, origPacket) {
                t.equal(!!origPacket, false, 'Packet has been removed')
              })
            }
          })
        })
      }
    })
    publisher.inStream.write(sent)
    sent.payload = 'world2world'
    publisher.inStream.write(sent)
  })
})

test('subscribe QoS 1', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

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
      subscriber.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      t.not(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.same(packet, expected, 'packet must match')
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
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
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
    subscriber.outStream.once('data', function (packet) {
      t.same(packet, expected, 'packet must match')
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
  t.plan(7)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
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
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

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
      t.not(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.same(packet, expected, 'packet must match')
    })
  })
})

test('restore multiple QoS 1 subscriptions not clean w/ authorizeSubscribe', function (t) {
  t.plan(11)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  const expected = {
    cmd: 'publish',
    topic: 'foo',
    payload: Buffer.from('bar'),
    qos: 1,
    dup: false,
    length: 10,
    retain: false
  }
  const publisher = connect(setup(broker))

  subscribe(t, subscriber, 'hello', 1, function () {
    subscribe(t, subscriber, 'foo', 1, function () {
      subscriber.inStream.end()
      broker.authorizeSubscribe = function (client, sub, done) {
        done(null, sub.topic === 'hello' ? 123 : sub)
      }
      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
        t.equal(connect.sessionPresent, true, 'session present is set to true')
        publisher.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world',
          qos: 1,
          messageId: 42
        })
        publisher.inStream.write({
          cmd: 'publish',
          topic: 'foo',
          payload: 'bar',
          qos: 1,
          messageId: 48
        })
      })
      publisher.outStream.on('data', function (packet) {
        t.equal(packet.cmd, 'puback')
      })

      subscriber.outStream.on('data', function (packet) {
        subscriber.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        t.not(packet.messageId, 48, 'messageId must differ')
        delete packet.messageId
        t.same(packet, expected, 'packet must match')
      })
    })
  })
})

test('remove stored subscriptions if connected with clean=true', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

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
  t.plan(8)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const opts = { clean: false, clientId: 'abcde' }
  let subscriber = connect(setup(broker), opts)
  const subscriberClient = {
    id: opts.clientId
  }
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
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

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
      payload: 'world world',
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
        t.not(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.same(packet, expected, 'packet must match')
        setImmediate(() => {
          const stream = broker.persistence.outgoingStream(subscriberClient)
          stream.pipe(concat(function (list) {
            t.equal(list.length, 1, 'should remain one item in queue')
            t.same(list[0].payload, Buffer.from('world world'), 'packet must match')
          }))
        })
      })
    })
  })
})

test('resend many publish on non-clean reconnect QoS 1', function (t) {
  t.plan(4)
  const broker = aedes()
  const clock = Faketimers.createClock()

  t.teardown(() => {
    broker.close.bind(broker)
    clock.reset.bind(clock)
  })

  const opts = { clean: false, clientId: 'abcde' }
  let subscriber = connect(setup(broker), opts)
  const publisher = connect(setup(broker))
  const { through } = require('../lib/utils')
  const total = through().writableHighWaterMark * 2

  let received = 0
  clock.setTimeout(() => {
    broker.close()
    t.equal(received, total)
  }, total)

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    for (let sent = 0; sent < total; sent++) {
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'message-' + sent,
        qos: 1,
        messageId: 42 + sent
      })
    }
    publisher.outStream.once('data', function (packet) {
      subscriber = connect(setup(broker), opts)
      subscriber.outStream.on('data', function (packet) {
        subscriber.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        received++
        clock.tick(1)
      })
    })
  })
})

test('do not resend QoS 1 packets at each reconnect', function (t) {
  t.plan(6)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
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
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

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

        t.not(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.same(packet, expected, 'packet must match')

        const subscriber2 = connect(setup(broker), { clean: false, clientId: 'abcde' })

        subscriber2.outStream.once('data', function (packet) {
          t.fail('this should never happen')
        })
      })
    })
  })
})

test('do not resend QoS 1 packets if reconnect is clean', function (t) {
  t.plan(4)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

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
    })
  })
})

test('do not resend QoS 1 packets at reconnect if puback was received', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
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
    const publisher = connect(setup(broker))

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
      t.same(packet, expected, 'packet must match')

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

      subscriber.outStream.once('data', function (packet) {
        t.fail('this should never happen')
      })
    })
  })
})

test('remove stored subscriptions after unsubscribe', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })

    subscriber.outStream.once('data', function (packet) {
      t.same(packet, {
        cmd: 'unsuback',
        messageId: 43,
        dup: false,
        length: 2,
        qos: 0,
        retain: false
      }, 'packet matches')

      subscriber.inStream.end()

      const publisher = connect(setup(broker))

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
  t.plan(8)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  const expected = {
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
        t.same(packet, expected, 'packet matches')
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
  t.plan(4)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  const expected = {
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
      t.same(packet, expected, 'packet matches')
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

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = connect(setup(broker))
  const expected = {
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
        t.same(packet.granted, [1])
        t.equal(packet.messageId, 24)
      }
      if (packet.cmd === 'publish') {
        s.inStream.write({
          cmd: 'puback',
          messageId: packet.messageId
        })
        delete packet.messageId
        t.same(packet, expected, 'packet must match')
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
