'use strict'

const { test } = require('tap')
const concat = require('concat-stream')
const { setup, connect, subscribe } = require('./helper')
const aedes = require('../')

function publish (t, s, packet, done) {
  const msgId = packet.messageId

  s.inStream.write(packet)

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'pubrec',
      messageId: msgId,
      length: 2,
      dup: false,
      retain: false,
      qos: 0
    }, 'pubrec must match')

    s.inStream.write({
      cmd: 'pubrel',
      messageId: msgId
    })

    s.outStream.once('data', function (packet) {
      t.deepEqual(packet, {
        cmd: 'pubcomp',
        messageId: msgId,
        length: 2,
        dup: false,
        retain: false,
        qos: 0
      }, 'pubcomp must match')

      if (done) {
        done()
      }
    })
  })
}

function receive (t, subscriber, expected, done) {
  subscriber.outStream.once('data', function (packet) {
    t.notEqual(packet.messageId, expected.messageId, 'messageId must differ')

    const msgId = packet.messageId
    delete packet.messageId
    delete expected.messageId
    t.deepEqual(packet, expected, 'packet must match')

    subscriber.inStream.write({
      cmd: 'pubrec',
      messageId: msgId
    })

    subscriber.outStream.once('data', function (packet) {
      subscriber.inStream.write({
        cmd: 'pubcomp',
        messageId: msgId
      })
      t.deepEqual(packet, {
        cmd: 'pubrel',
        messageId: msgId,
        length: 2,
        qos: 1,
        retain: false,
        dup: false
      }, 'pubrel must match')

      if (done) {
        done()
      }
    })
  })
}

test('publish QoS 2', function (t) {
  t.plan(2)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }
  publish(t, s, packet)
})

test('subscribe QoS 2', function (t) {
  t.plan(8)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    publish(t, publisher, toPublish)

    receive(t, subscriber, toPublish)
  })
})

test('publish QoS 2 throws error on write', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.tearDown(s.broker.close.bind(s.broker))

  s.broker.on('client', function (client) {
    client.connected = false
    client.connecting = false

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 2,
      messageId: 42
    })
  })

  s.broker.on('clientError', function (client, err) {
    t.equal(err.message, 'connection closed', 'throws error')
  })
})

test('pubrec handler calls done when outgoingUpdate fails (clean=false)', function (t) {
  t.plan(1)

  const s = connect(setup(), { clean: false })
  t.tearDown(s.broker.close.bind(s.broker))

  var handle = require('../lib/handlers/pubrec.js')

  s.broker.persistence.outgoingUpdate = function (client, pubrel, done) {
    done(Error('throws error'))
  }

  handle(s.client, { messageId: 42 }, function done () {
    t.pass('calls done on error')
  })
})

test('client.publish with clean=true subscribption QoS 2', function (t) {
  t.plan(8)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }
  var brokerClient = null

  broker.on('client', function (client) {
    brokerClient = client

    brokerClient.on('error', function (err) {
      t.error(err)
    })
  })

  const subscriber = connect(setup(broker), { clean: true })

  subscribe(t, subscriber, 'hello', 2, function () {
    t.pass('subscribed')
    receive(t, subscriber, toPublish)
    brokerClient.publish(toPublish, function (err) {
      t.error(err)
    })
  })
})

test('call published method with client with QoS 2', function (t) {
  t.plan(9)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  broker.published = function (packet, client, cb) {
    // Client is null for all server publishes
    if (packet.topic.split('/')[0] !== '$SYS') {
      t.ok(client, 'client must be passed to published method')
      cb()
    }
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    publish(t, publisher, toPublish)

    receive(t, subscriber, toPublish)
  })
})

;[true, false].forEach(function (cleanSession) {
  test(`authorized forward publish packets in QoS 2 [clean=${cleanSession}]`, function (t) {
    t.plan(9)

    const broker = aedes()
    t.tearDown(broker.close.bind(broker))

    const opts = { clean: cleanSession }
    const publisher = connect(setup(broker))
    const subscriber = connect(setup(broker), { ...opts, clientId: 'abcde' })
    const forwarded = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      dup: false,
      messageId: undefined
    }
    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      length: 14,
      dup: false
    }
    broker.authorizeForward = function (client, packet) {
      forwarded.brokerId = broker.id
      forwarded.brokerCounter = broker.counter
      t.deepEqual(packet, forwarded, 'forwarded packet must match')
      return packet
    }

    subscribe(t, subscriber, 'hello', 2, function () {
      subscriber.outStream.once('data', function (packet) {
        t.notEqual(packet.messageId, 42)
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
      })

      publish(t, publisher, {
        cmd: 'publish',
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 2,
        retain: false,
        messageId: 42,
        dup: false
      }, function () {
        const stream = broker.persistence.outgoingStream({ id: 'abcde' })
        stream.pipe(concat(function (list) {
          if (cleanSession) {
            t.equal(list.length, 0, 'should have empty item in queue')
          } else {
            t.equal(list.length, 1, 'should have one item in queue')
          }
        }))
      })
    })
  })
})

;[true, false].forEach(function (cleanSession) {
  test(`unauthorized forward publish packets in QoS 2 [clean=${cleanSession}]`, function (t) {
    t.plan(6)

    const broker = aedes()
    t.tearDown(broker.close.bind(broker))

    const opts = { clean: cleanSession }

    const publisher = connect(setup(broker))
    const subscriber = connect(setup(broker), { ...opts, clientId: 'abcde' })

    broker.authorizeForward = function (client, packet) {

    }

    subscribe(t, subscriber, 'hello', 2, function () {
      subscriber.outStream.once('data', function (packet) {
        t.fail('should not receive any packets')
      })

      publish(t, publisher, {
        cmd: 'publish',
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 2,
        retain: false,
        messageId: 42,
        dup: false
      }, function () {
        const stream = broker.persistence.outgoingStream({ id: 'abcde' })
        stream.pipe(concat(function (list) {
          t.equal(list.length, 0, 'should empty in queue')
        }))
      })
    })
  })
})

test('subscribe QoS 0, but publish QoS 2', function (t) {
  t.plan(6)

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
    retain: false
  }

  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
    })

    publish(t, publisher, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      messageId: 42,
      dup: false
    })
  })
})

test('subscribe QoS 1, but publish QoS 2', function (t) {
  t.plan(6)

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

    publish(t, publisher, {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2,
      retain: false,
      messageId: 42,
      dup: false
    })
  })
})

test('restore QoS 2 subscriptions not clean', function (t) {
  t.plan(9)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
      t.equal(connect.sessionPresent, true, 'session present is set to true')
      publish(t, publisher, expected)
    })

    receive(t, subscriber, expected)
  })
})

test('resend publish on non-clean reconnect QoS 2', function (t) {
  t.plan(8)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const opts = { clean: false, clientId: 'abcde' }
  var subscriber = connect(setup(broker), opts)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

    publish(t, publisher, expected, function () {
      subscriber = connect(setup(broker), opts)

      receive(t, subscriber, expected)
    })
  })
})

test('resend pubrel on non-clean reconnect QoS 2', function (t) {
  t.plan(9)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const opts = { clean: false, clientId: 'abcde' }
  var subscriber = connect(setup(broker), opts)
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    subscriber.inStream.end()

    const publisher = connect(setup(broker))

    publish(t, publisher, expected, function () {
      subscriber = connect(setup(broker), opts)

      subscriber.outStream.once('data', function (packet) {
        t.notEqual(packet.messageId, expected.messageId, 'messageId must differ')

        const msgId = packet.messageId
        delete packet.messageId
        delete expected.messageId
        t.deepEqual(packet, expected, 'packet must match')

        subscriber.inStream.write({
          cmd: 'pubrec',
          messageId: msgId
        })

        subscriber.outStream.once('data', function (packet) {
          t.deepEqual(packet, {
            cmd: 'pubrel',
            messageId: msgId,
            length: 2,
            qos: 1,
            retain: false,
            dup: false
          }, 'pubrel must match')

          subscriber.inStream.end()

          subscriber = connect(setup(broker), opts)

          subscriber.outStream.once('data', function (packet) {
            t.deepEqual(packet, {
              cmd: 'pubrel',
              messageId: msgId,
              length: 2,
              qos: 1,
              retain: false,
              dup: false
            }, 'pubrel must match')

            subscriber.inStream.write({
              cmd: 'pubcomp',
              messageId: msgId
            })
          })
        })
      })
    })
  })
})

test('publish after disconnection', function (t) {
  t.plan(10)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const publisher = connect(setup(broker))
  const subscriber = connect(setup(broker))
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }
  const toPublish2 = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('worl2'),
    qos: 2,
    messageId: 43,
    dup: false,
    length: 14,
    retain: false
  }

  subscribe(t, subscriber, 'hello', 2, function () {
    publish(t, publisher, toPublish)

    receive(t, subscriber, toPublish, function () {
      publish(t, publisher, toPublish2)
    })
  })
})

test('multiple publish and store one', function (t) {
  t.plan(2)

  const broker = aedes()

  const sid = {
    id: 'abcde'
  }
  const s = connect(setup(broker), { clientId: sid.id })
  const toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    retain: false,
    dup: false,
    messageId: 42
  }

  var count = 5
  while (count--) {
    s.inStream.write(toPublish)
  }
  var recvcnt = 0
  s.outStream.on('data', function (packet) {
    if (++recvcnt < 5) return
    broker.close(function () {
      broker.persistence.incomingGetPacket(sid, toPublish, function (err, origPacket) {
        delete origPacket.brokerId
        delete origPacket.brokerCounter
        t.deepEqual(origPacket, toPublish, 'packet must match')
        t.error(err)
      })
    })
  })
})

test('packet is written to stream after being stored', function (t) {
  const s = connect(setup())

  var broker = s.broker

  t.tearDown(broker.close.bind(s.broker))

  var packetStored = false

  var fn = broker.persistence.incomingStorePacket.bind(broker.persistence)

  s.broker.persistence.incomingStorePacket = function (client, packet, done) {
    packetStored = true
    t.pass('packet stored')
    fn(client, packet, done)
  }

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }

  publish(t, s, packet)

  s.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'pubrec', 'pubrec received')
    t.equal(packetStored, true, 'after packet store')
    t.end()
  })
})
