'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

function publish (t, publisher, packet, done) {
  var msgId = packet.messageId

  publisher.inStream.write(packet)

  publisher.outStream.once('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'pubrec',
      messageId: msgId,
      length: 2,
      dup: false,
      retain: false,
      qos: 0
    }, 'pubrec must match')

    publisher.inStream.write({
      cmd: 'pubrel',
      messageId: msgId
    })

    publisher.outStream.once('data', function (packet) {
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

    var msgId = packet.messageId
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

      done()
    })
  })
}

test('publish QoS 2', function (t) {
  t.plan(2)

  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }

  var p = connect(setup(), {}, () => {
    publish(t, p, packet, t.end.bind(t))
  })
})

test('subscribe QoS 2', function (t) {
  t.plan(8)

  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    publisher.broker.once('clientReady', () => {
      subscribe(t, subscriber, 'hello', 2, function () {
        publish(t, publisher, toPublish)

        receive(t, subscriber, toPublish, t.end.bind(t))
      })
    })
  })
})

test('client.publish with clean=true subscribption QoS 2', function (t) {
  t.plan(8)

  var broker = aedes()
  var toPublish = {
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

  var subscriber = connect(setup(broker), { clean: true }, () => {
    subscribe(t, subscriber, 'hello', 2, function () {
      t.pass('subscribed')
      receive(t, subscriber, toPublish, t.end.bind(t))
      brokerClient.publish(toPublish, function (err) {
        t.error(err)
      })
    })
  })
})

test('call published method with client with QoS 2', function (t) {
  t.plan(10)

  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var toPublish = {
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

  subscriber.broker.once('clientReady', () => {
    publisher.broker.once('clientReady', () => {
      subscribe(t, subscriber, 'hello', 2, function () {
        publish(t, publisher, toPublish)

        receive(t, subscriber, toPublish, t.pass.bind(t))
      })
    })
  })
})

test('subscribe QoS 0, but publish QoS 2', function (t) {
  t.plan(6)

  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker, false))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    publisher.broker.once('clientReady', () => {
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
  })
  broker.on('closed', t.end.bind(t))
})

test('subscribe QoS 1, but publish QoS 2', function (t) {
  t.plan(6)

  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker, false))
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    dup: false,
    length: 14,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    publisher.broker.once('clientReady', () => {
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
  })
  broker.on('closed', t.end.bind(t))
})

test('restore QoS 2 subscriptions not clean', function (t) {
  t.plan(9)

  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    subscribe(t, subscriber, 'hello', 2, function () {
      subscriber.inStream.end()

      publisher = connect(setup(broker))

      publisher.broker.once('clientReady', () => {
        subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
          t.equal(connect.sessionPresent, true, 'session present is set to true')
          publish(t, publisher, expected)
        })

        receive(t, subscriber, expected, t.end.bind(t))
      })
    })
  })
})

test('resend publish on non-clean reconnect QoS 2', function (t) {
  t.plan(8)

  var broker = aedes()
  var publisher
  var opts = { clean: false, clientId: 'abcde' }
  var subscriber = connect(setup(broker), opts)
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    subscribe(t, subscriber, 'hello', 2, function () {
      subscriber.inStream.end()

      publisher = connect(setup(broker))

      publisher.broker.once('clientReady', () => {
        publish(t, publisher, expected, function () {
          subscriber = connect(setup(broker), opts)

          receive(t, subscriber, expected, t.end.bind(t))
        })
      })
    })
  })
})

test('resend pubrel on non-clean reconnect QoS 2', function (t) {
  t.plan(9)

  var broker = aedes()
  var publisher
  var opts = { clean: false, clientId: 'abcde' }
  var subscriber = connect(setup(broker), opts)
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    dup: false,
    length: 14,
    messageId: 42,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    subscribe(t, subscriber, 'hello', 2, function () {
      subscriber.inStream.end()

      publisher = connect(setup(broker))

      publisher.broker.once('clientReady', () => {
        publish(t, publisher, expected, function () {
          subscriber = connect(setup(broker), opts)

          subscriber.outStream.once('data', function (packet) {
            t.notEqual(packet.messageId, expected.messageId, 'messageId must differ')

            var msgId = packet.messageId
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

                t.end()
              })
            })
          })
        })
      })
    })
  })
})

test('publish after disconnection', function (t) {
  t.plan(10)

  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }
  var toPublish2 = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('worl2'),
    qos: 2,
    messageId: 43,
    dup: false,
    length: 14,
    retain: false
  }

  subscriber.broker.once('clientReady', () => {
    publisher.broker.once('clientReady', () => {
      subscribe(t, subscriber, 'hello', 2, function () {
        publish(t, publisher, toPublish)

        receive(t, subscriber, toPublish, function () {
          publish(t, publisher, toPublish2, t.end.bind(t))
        })
      })
    })
  })
})

test('multiple publish and store one', function (t) {
  t.plan(2)

  var broker = aedes()
  var sid = {
    id: 'abcde'
  }
  var s = connect(setup(broker), { clientId: sid.id })
  var toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 2,
    retain: false,
    messageId: 42
  }

  s.broker.once('clientReady', () => {
    var count = 5
    while (--count) {
      s.inStream.write(toPublish)
    }
  })
  broker.on('closed', function () {
    broker.persistence.incomingGetPacket(sid, toPublish, function (err, origPacket) {
      delete origPacket.brokerId
      delete origPacket.brokerCounter
      t.deepEqual(origPacket, toPublish, 'packet must match')
      t.error(err)
      t.end()
    })
  })
})
