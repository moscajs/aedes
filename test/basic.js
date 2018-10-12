'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var eos = require('end-of-stream')
var setup = helper.setup
var connect = helper.connect
var noError = helper.noError
var subscribe = helper.subscribe

test('connect and connack (minimal)', function (t) {
  var s = setup()

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
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
    t.end()
  })
})

test('publish QoS 0', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    messageId: 0
  }

  s.broker.mq.on('hello', function (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    t.deepEqual(packet, expected, 'packet matches')
    cb()
    t.end()
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('subscribe QoS 0', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  subscribe(t, s, 'hello', 0, function () {
    s.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet matches')
      t.end()
    })

    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
})

test('does not die badly on connection error', function (t) {
  t.plan(3)
  var s = connect(setup())

  s.inStream.write({
    cmd: 'subscribe',
    messageId: 42,
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }]
  })

  s.broker.on('clientError', function (client, err) {
    t.ok(client, 'client is passed')
    t.ok(err, 'err is passed')
  })

  s.outStream.on('data', function (packet) {
    s.conn._writableState.ended = true
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    }, function () {
      t.pass('calls the callback')
    })
  })
})

test('unsubscribe', function (t) {
  t.plan(5)

  var s = noError(connect(setup()), t)

  subscribe(t, s, 'hello', 0, function () {
    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })

    s.outStream.once('data', function (packet) {
      t.deepEqual(packet, {
        cmd: 'unsuback',
        messageId: 43,
        dup: false,
        length: 2,
        qos: 0,
        retain: false
      }, 'packet matches')

      s.outStream.on('data', function (packet) {
        t.fail('packet received')
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world'
      }, function () {
        t.pass('publish finished')
      })
    })
  })
})

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

test('unsubscribe without subscribe', function (t) {
  t.plan(1)

  var s = noError(connect(setup()), t)

  s.inStream.write({
    cmd: 'unsubscribe',
    messageId: 43,
    unsubscriptions: ['hello']
  })

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'unsuback',
      messageId: 43,
      dup: false,
      length: 2,
      qos: 0,
      retain: false
    }, 'packet matches')
  })
})

test('unsubscribe on disconnect for a clean=true client', function (t) {
  var opts = { clean: true }
  var s = noError(connect(setup(), opts), t)

  subscribe(t, s, 'hello', 0, function () {
    s.conn.emit('close')
    s.outStream.on('data', function () {
      t.fail('should not receive any more messages')
    })
    s.broker.once('unsubscribe', function () {
      t.pass('should emit unsubscribe')
      t.end()
    })
    s.broker.once('closed', function () {
      t.ok(true)
    })
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    }, function () {
      t.pass('calls the callback')
    })
  })
})

test('unsubscribe on disconnect for a clean=false client', function (t) {
  var opts = { clean: false }
  var s = noError(connect(setup(), opts), t)

  subscribe(t, s, 'hello', 0, function () {
    s.conn.emit('close')
    s.outStream.on('data', function () {
      t.fail('should not receive any more messages')
    })
    s.broker.once('unsubscribe', function () {
      t.fail('should not emit unsubscribe')
    })
    s.broker.once('closed', function () {
      t.ok(true)
      t.end()
    })
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    }, function () {
      t.pass('calls the callback')
    })
  })
})

test('disconnect', function (t) {
  var s = noError(connect(setup()), t)

  s.outStream.on('finish', function () {
    t.end()
  })

  s.inStream.write({
    cmd: 'disconnect'
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

test('closes', function (t) {
  t.plan(2)

  var broker = aedes()
  var client = noError(connect(setup(broker)))
  eos(client.conn, t.pass.bind('client closes'))

  broker.close(function (err) {
    t.error(err, 'no error')
  })
})

test('testing other event', function (t) {
  var broker = aedes()
  var client = setup(broker)

  broker.on('connectionError', function (client, error) {
    t.notOk(client.id, null)
    t.end()
  })
  client.conn.emit('error', 'Connect not yet arrived')
})

test('connect without a clientId for MQTT 3.1.1', function (t) {
  var s = setup()

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 0
  })

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
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

    t.end()
  })
})

test('disconnect another client with the same clientId', function (t) {
  t.plan(2)

  var broker = aedes()
  var c1 = connect(setup(broker), {
    clientId: 'abcde'
  }, function () {
    eos(c1.conn, function () {
      t.pass('first client disconnected')
    })

    connect(setup(broker), {
      clientId: 'abcde'
    }, function () {
      t.pass('second client connected')

      // setImmediate needed because eos
      // will happen at the next tick
      setImmediate(t.end.bind(t))
    })
  })
})

test('disconnect if another broker connects the same client', function (t) {
  t.plan(2)

  var broker = aedes()
  var c1 = connect(setup(broker), {
    clientId: 'abcde'
  }, function () {
    eos(c1.conn, function () {
      t.pass('first client disconnected')
    })

    broker.publish({
      topic: '$SYS/anotherBroker/new/clients',
      payload: Buffer.from('abcde')
    }, function () {
      t.pass('published')

      // setImmediate needed because eos
      // will happen at the next tick
      setImmediate(t.end.bind(t))
    })
  })
})

test('publish to $SYS/broker/new/clients', function (t) {
  t.plan(1)

  var broker = aedes()

  broker.mq.on('$SYS/' + broker.id + '/new/clients', function (packet, done) {
    t.equal(packet.payload.toString(), 'abcde', 'clientId matches')
    done()
  })

  connect(setup(broker), {
    clientId: 'abcde'
  })
})

test('restore QoS 0 subscriptions not clean', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' })
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
    subscriber.inStream.end()

    publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function (connect) {
      t.equal(connect.sessionPresent, true, 'session present is set to true')
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world',
        qos: 0
      })
    })

    subscriber.outStream.once('data', function (packet) {
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })
  })
})

test('do not restore QoS 0 subscriptions when clean', function (t) {
  var broker = aedes()
  var publisher
  var subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' })

  subscribe(t, subscriber, 'hello', 0, function () {
    subscriber.inStream.end()
    t.equal(subscriber.broker.persistence._subscriptions.size, 0, 'no previous subscriptions restored')

    publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' }, function (connect) {
      t.equal(connect.sessionPresent, false, 'session present is set to false')
      publisher.inStream.write({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world',
        qos: 0
      })
    })

    subscriber.outStream.once('data', function (packet) {
      t.fail('packet received')
      t.end()
    })
    eos(subscriber.conn, function () {
      t.equal(subscriber.broker.connectedClients, 0, 'no connected clients')
      t.end()
    })
  })
})

test('double sub does not double deliver', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  subscribe(t, s, 'hello', 0, function () {
    subscribe(t, s, 'hello', 0, function () {
      s.outStream.once('data', function (packet) {
        t.deepEqual(packet, expected, 'packet matches')
        s.outStream.on('data', function () {
          t.fail('double deliver')
        })
        // wait for a tick, so it will double deliver
        setImmediate(t.end.bind(t))
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world'
      })
    })
  })
})

test('overlapping sub does not double deliver', function (t) {
  var s = connect(setup())
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  subscribe(t, s, 'hello', 0, function () {
    subscribe(t, s, 'hello/#', 0, function () {
      s.outStream.once('data', function (packet) {
        t.deepEqual(packet, expected, 'packet matches')
        s.outStream.on('data', function () {
          t.fail('double deliver')
        })
        // wait for a tick, so it will double deliver
        setImmediate(t.end.bind(t))
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world'
      })
    })
  })
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

test('publish empty topic', function (t) {
  var s = connect(setup())

  subscribe(t, s, '#', 0, function () {
    s.outStream.once('data', function (packet) {
      t.fail('no packet')
      t.end()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: '',
      payload: 'world'
    })
  })

  eos(s.conn, function () {
    t.equal(s.broker.connectedClients, 0, 'no connected clients')
    t.end()
  })
})

test('publish invalid topic with #', function (t) {
  var s = connect(setup())

  subscribe(t, s, '#', 0, function () {
    s.outStream.once('data', function (packet) {
      t.fail('no packet')
      t.end()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello/#',
      payload: 'world'
    })
  })

  s.broker.on('clientError', function () {
    t.end()
  })
})

test('publish invalid topic with +', function (t) {
  var s = connect(setup())

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
    t.end()
  })
})

;['base/#/sub', 'base/#sub', 'base/sub#', 'base/xyz+/sub', 'base/+xyz/sub'].forEach(function (topic) {
  test('subscribe to invalid topic with "' + topic + '"', function (t) {
    var s = connect(setup())

    s.broker.on('clientError', function () {
      t.end()
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
    var s = connect(setup())

    s.broker.on('clientError', function () {
      t.end()
    })

    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 24,
      unsubscriptions: [topic]
    })
  })
})

test('clear drain', function (t) {
  t.plan(4)

  var s = connect(setup())

  subscribe(t, s, 'hello', 0, function () {
    // fake a busy socket
    s.conn.write = function (chunk, enc, cb) {
      return false
    }

    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    }, function () {
      t.pass('callback called')
    })

    s.conn.destroy()
  })
})

test('id option', function (t) {
  t.plan(2)

  var broker1 = aedes()
  setup(broker1)
  t.ok(broker1.id, 'broker gets random id when id option not set')

  var broker2 = aedes({ id: 'abc' })
  setup(broker2)
  t.equal(broker2.id, 'abc', 'broker id equals id option when set')
})
