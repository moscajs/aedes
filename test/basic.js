'use strict'

const { test } = require('tap')
const eos = require('end-of-stream')
const { setup, connect, subscribe, subscribeMultiple, noError } = require('./helper')
const aedes = require('../')
const proxyquire = require('proxyquire')

test('test aedes.createBroker', function (t) {
  t.plan(1)

  const broker = aedes.createBroker()
  t.teardown(broker.close.bind(broker))

  connect(setup(broker), {}, function () {
    t.pass('connected')
  })
})

test('publish QoS 0', function (t) {
  t.plan(2)

  const s = connect(setup(), { clientId: 'my-client-xyz-5' })
  t.teardown(s.broker.close.bind(s.broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false,
    clientId: 'my-client-xyz-5'
  }

  s.broker.mq.on('hello', function (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    t.equal(packet.messageId, undefined, 'MUST not contain a packet identifier in QoS 0')
    t.same(packet, expected, 'packet matches')
    cb()
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  })
})

test('messageId shoud reset to 1 if it reached 65535', function (t) {
  t.plan(7)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  const publishPacket = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  }
  let count = 0
  s.broker.on('clientReady', function (client) {
    subscribe(t, s, 'hello', 1, function () {
      client._nextId = 65535
      s.outStream.on('data', function (packet) {
        if (packet.cmd === 'puback') {
          t.equal(packet.messageId, 42)
        }
        if (packet.cmd === 'publish') {
          t.equal(packet.messageId, count++ === 0 ? 65535 : 1)
        }
      })
      s.inStream.write(publishPacket)
      s.inStream.write(publishPacket)
    })
  })
})

test('publish empty topic throws error', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'publish',
    topic: '',
    payload: 'world'
  })

  s.broker.on('clientError', function (client, err) {
    t.pass('should emit error')
  })
})

test('publish to $SYS topic throws error', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'publish',
    topic: '$SYS/not/allowed',
    payload: 'world'
  })

  s.broker.on('clientError', function (client, err) {
    t.pass('should emit error')
  })
})

;[{ qos: 0, clean: false }, { qos: 0, clean: true }, { qos: 1, clean: false }, { qos: 1, clean: true }].forEach(function (ele) {
  test('subscribe a single topic in QoS ' + ele.qos + ' [clean=' + ele.clean + ']', function (t) {
    t.plan(5)

    const s = connect(setup(), { clean: ele.clean })
    t.teardown(s.broker.close.bind(s.broker))

    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      dup: false,
      length: 12,
      qos: 0,
      retain: false
    }
    const expectedSubs = ele.clean ? null : [{ topic: 'hello', qos: ele.qos, rh: undefined, rap: undefined, nl: undefined }]

    subscribe(t, s, 'hello', ele.qos, function () {
      s.outStream.once('data', function (packet) {
        t.same(packet, expected, 'packet matches')
      })

      s.broker.persistence.subscriptionsByClient(s.client, function (_, subs) {
        t.same(subs, expectedSubs)
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world'
      })
    })
  })
})

// Catch invalid packet writeToStream errors
test('return write errors to callback', function (t) {
  t.plan(1)

  const write = proxyquire('../lib/write.js', {
    'mqtt-packet': {
      writeToStream: () => {
        throw Error('error')
      }
    }
  })

  const client = {
    conn: {
      writable: true
    },
    connecting: true
  }

  write(client, {}, function (err) {
    t.equal(err.message, 'packet received not valid', 'should return the error to callback')
  })
})

;[{ qos: 0, clean: false }, { qos: 0, clean: true }, { qos: 1, clean: false }, { qos: 1, clean: true }].forEach(function (ele) {
  test('subscribe multipe topics in QoS ' + ele.qos + ' [clean=' + ele.clean + ']', function (t) {
    t.plan(5)

    const s = connect(setup(), { clean: ele.clean })
    t.teardown(s.broker.close.bind(s.broker))

    const expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world'),
      dup: false,
      length: 12,
      qos: 0,
      retain: false
    }
    const subs = [
      { topic: 'hello', qos: ele.qos, rh: undefined, rap: undefined, nl: undefined },
      { topic: 'world', qos: ele.qos, rh: undefined, rap: undefined, nl: undefined }
    ]
    const expectedSubs = ele.clean ? null : subs

    subscribeMultiple(t, s, subs, [ele.qos, ele.qos], function () {
      s.outStream.on('data', function (packet) {
        t.same(packet, expected, 'packet matches')
      })

      s.broker.persistence.subscriptionsByClient(s.client, function (_, saveSubs) {
        t.same(saveSubs, expectedSubs)
      })

      s.broker.publish({
        cmd: 'publish',
        topic: 'hello',
        payload: 'world'
      })
    })
  })
})

test('does not die badly on connection error', function (t) {
  t.plan(3)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

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
    s.conn.destroy()
    s.broker.publish({
      cmd: 'publish',
      topic: 'hello',
      payload: Buffer.from('world')
    }, function () {
      t.pass('calls the callback')
    })
  })
})

// Guarded in mqtt-packet
test('subscribe should have messageId', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'subscribe',
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }]
  })
  s.broker.on('connectionError', function (client, err) {
    t.ok(err.message, 'Invalid messageId')
  })
})

test('subscribe with messageId 0 should return suback', function (t) {
  t.plan(1)

  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'subscribe',
    subscriptions: [{
      topic: 'hello',
      qos: 0
    }],
    messageId: 0
  })
  s.outStream.once('data', function (packet) {
    t.same(packet, {
      cmd: 'suback',
      messageId: 0,
      dup: false,
      length: 3,
      qos: 0,
      retain: false,
      granted: [
        0
      ]
    }, 'packet matches')
  })
})

test('unsubscribe', function (t) {
  t.plan(5)

  const s = noError(connect(setup()), t)
  t.teardown(s.broker.close.bind(s.broker))

  subscribe(t, s, 'hello', 0, function () {
    s.inStream.write({
      cmd: 'unsubscribe',
      messageId: 43,
      unsubscriptions: ['hello']
    })

    s.outStream.once('data', function (packet) {
      t.same(packet, {
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

test('unsubscribe without subscribe', function (t) {
  t.plan(1)

  const s = noError(connect(setup()), t)
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'unsubscribe',
    messageId: 43,
    unsubscriptions: ['hello']
  })

  s.outStream.once('data', function (packet) {
    t.same(packet, {
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
  t.plan(6)

  const opts = { clean: true }
  const s = connect(setup(), opts)
  t.teardown(s.broker.close.bind(s.broker))

  subscribe(t, s, 'hello', 0, function () {
    s.conn.destroy(null, function () {
      t.pass('closed streams')
    })
    s.outStream.on('data', function () {
      t.fail('should not receive any more messages')
    })
    s.broker.once('unsubscribe', function () {
      t.pass('should emit unsubscribe')
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
  t.plan(5)

  const opts = { clean: false }
  const s = connect(setup(), opts)
  t.teardown(s.broker.close.bind(s.broker))

  subscribe(t, s, 'hello', 0, function () {
    s.conn.destroy(null, function () {
      t.pass('closed streams')
    })
    s.outStream.on('data', function () {
      t.fail('should not receive any more messages')
    })
    s.broker.once('unsubscribe', function () {
      t.fail('should not emit unsubscribe')
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
  t.plan(1)

  const s = noError(connect(setup()), t)
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientDisconnect', function () {
    t.pass('closed stream')
  })

  s.inStream.write({
    cmd: 'disconnect'
  })
})

test('disconnect client on wrong cmd', function (t) {
  t.plan(1)

  const s = noError(connect(setup()), t)
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientDisconnect', function () {
    t.pass('closed stream')
  })

  s.broker.on('clientReady', function (c) {
    // don't use stream write here because it will throw an error on mqtt_packet genetete
    c._parser.emit('packet', { cmd: 'pippo' })
  })
})

test('client closes', function (t) {
  t.plan(5)

  const broker = aedes()
  const client = noError(connect(setup(broker), { clientId: 'abcde' }))
  broker.on('clientReady', function () {
    const brokerClient = broker.clients.abcde
    t.equal(brokerClient.connected, true, 'client connected')
    eos(client.conn, t.pass.bind(t, 'client closes'))
    setImmediate(() => {
      brokerClient.close(function () {
        t.equal(broker.clients.abcde, undefined, 'client instance is removed')
      })
      t.equal(brokerClient.connected, false, 'client disconnected')
      broker.close(function (err) {
        t.error(err, 'no error')
      })
    })
  })
})

test('broker closes', function (t) {
  t.plan(4)

  const broker = aedes()
  const client = noError(connect(setup(broker), {
    clientId: 'abcde'
  }, function () {
    eos(client.conn, t.pass.bind(t, 'client closes'))
    broker.close(function (err) {
      t.error(err, 'no error')
      t.ok(broker.closed)
      t.equal(broker.clients.abcde, undefined, 'client instance is removed')
    })
  }))
})

test('broker closes gracefully', function (t) {
  t.plan(7)

  const broker = aedes()
  const client1 = noError(connect(setup(broker), {
  }, function () {
    const client2 = noError(connect(setup(broker), {
    }, function () {
      t.equal(broker.connectedClients, 2, '2 connected clients')
      eos(client1.conn, t.pass.bind(t, 'client1 closes'))
      eos(client2.conn, t.pass.bind(t, 'client2 closes'))
      broker.close(function (err) {
        t.error(err, 'no error')
        t.ok(broker.mq.closed, 'broker mq closes')
        t.ok(broker.closed, 'broker closes')
        t.equal(broker.connectedClients, 0, 'no connected clients')
      })
    }))
  }))
})

test('testing other event', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const client = setup(broker)

  broker.on('connectionError', function (client, error) {
    t.notOk(client.id, null)
  })
  client.conn.emit('error', 'Connect not yet arrived')
})

test('connect without a clientId for MQTT 3.1.1', function (t) {
  t.plan(1)

  const s = setup()
  t.teardown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 0
  })

  s.outStream.on('data', function (packet) {
    t.same(packet, {
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
  })
})

test('disconnect existing client with the same clientId', function (t) {
  t.plan(2)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const c1 = connect(setup(broker), {
    clientId: 'abcde'
  }, function () {
    eos(c1.conn, function () {
      t.pass('first client disconnected')
    })

    connect(setup(broker), {
      clientId: 'abcde'
    }, function () {
      t.pass('second client connected')
    })
  })
})

test('disconnect if another broker connects the same clientId', function (t) {
  t.plan(2)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const c1 = connect(setup(broker), {
    clientId: 'abcde'
  }, function () {
    eos(c1.conn, function () {
      t.pass('disconnect first client')
    })

    broker.publish({
      topic: '$SYS/anotherBroker/new/clients',
      payload: Buffer.from('abcde')
    }, function () {
      t.pass('second client connects to another broker')
    })
  })
})

test('publish to $SYS/broker/new/clients', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.mq.on('$SYS/' + broker.id + '/new/clients', function (packet, done) {
    t.equal(packet.payload.toString(), 'abcde', 'clientId matches')
    done()
  })

  connect(setup(broker), {
    clientId: 'abcde'
  })
})

test('publish to $SYS/broker/new/subsribers and $SYS/broker/new/unsubsribers', function (t) {
  t.plan(7)
  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const sub = {
    topic: 'hello',
    qos: 0
  }

  broker.mq.on('$SYS/' + broker.id + '/new/subscribes', function (packet, done) {
    const payload = JSON.parse(packet.payload.toString())
    t.equal(payload.clientId, 'abcde', 'clientId matches')
    t.same(payload.subs, [sub], 'subscriptions matches')
    done()
  })

  broker.mq.on('$SYS/' + broker.id + '/new/unsubscribes', function (packet, done) {
    const payload = JSON.parse(packet.payload.toString())
    t.equal(payload.clientId, 'abcde', 'clientId matches')
    t.same(payload.subs, [sub.topic], 'unsubscriptions matches')
    done()
  })

  const subscriber = connect(setup(broker), {
    clean: false, clientId: 'abcde'
  }, function () {
    subscribe(t, subscriber, sub.topic, sub.qos, function () {
      subscriber.inStream.write({
        cmd: 'unsubscribe',
        messageId: 43,
        unsubscriptions: ['hello']
      })
    })
  })
})

test('restore QoS 0 subscriptions not clean', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    dup: false,
    length: 12,
    retain: false
  }

  let subscriber = connect(setup(broker), {
    clean: false, clientId: 'abcde'
  }, function () {
    subscribe(t, subscriber, 'hello', 0, function () {
      subscriber.inStream.end()

      const publisher = connect(setup(broker), {
      }, function () {
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
          t.same(packet, expected, 'packet must match')
        })
      })
    })
  })
})

test('do not restore QoS 0 subscriptions when clean', function (t) {
  t.plan(5)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  let subscriber = connect(setup(broker), {
    clean: true, clientId: 'abcde'
  }, function () {
    subscribe(t, subscriber, 'hello', 0, function () {
      subscriber.inStream.end()
      subscriber.broker.persistence.subscriptionsByClient(broker.clients.abcde, function (_, subs, client) {
        t.equal(subs, null, 'no previous subscriptions restored')
      })
      const publisher = connect(setup(broker), {
      }, function () {
        subscriber = connect(setup(broker), {
          clean: true, clientId: 'abcde'
        }, function (connect) {
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
        })
      })
    })
  })
})

test('double sub does not double deliver', function (t) {
  t.plan(7)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }
  const s = connect(setup(), {
  }, function () {
    subscribe(t, s, 'hello', 0, function () {
      subscribe(t, s, 'hello', 0, function () {
        s.outStream.once('data', function (packet) {
          t.same(packet, expected, 'packet matches')
          s.outStream.on('data', function () {
            t.fail('double deliver')
          })
        })

        s.broker.publish({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world'
        })
      })
    })
  })
  t.teardown(s.broker.close.bind(s.broker))
})

test('overlapping sub does not double deliver', function (t) {
  t.plan(7)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }
  const s = connect(setup(), {
  }, function () {
    subscribe(t, s, 'hello', 0, function () {
      subscribe(t, s, 'hello/#', 0, function () {
        s.outStream.once('data', function (packet) {
          t.same(packet, expected, 'packet matches')
          s.outStream.on('data', function () {
            t.fail('double deliver')
          })
        })

        s.broker.publish({
          cmd: 'publish',
          topic: 'hello',
          payload: 'world'
        })
      })
    })
  })
  t.teardown(s.broker.close.bind(s.broker))
})

test('clear drain', function (t) {
  t.plan(4)

  const s = connect(setup(), {
  }, function () {
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

  t.teardown(s.broker.close.bind(s.broker))
})

test('id option', function (t) {
  t.plan(2)

  const broker1 = aedes()

  setup(broker1).conn.destroy()
  t.ok(broker1.id, 'broker gets random id when id option not set')

  const broker2 = aedes({ id: 'abc' })
  setup(broker2).conn.destroy()
  t.equal(broker2.id, 'abc', 'broker id equals id option when set')

  t.teardown(() => {
    broker1.close()
    broker2.close()
  })
})

test('not duplicate client close when client error occurs', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  connect(setup(broker))
  broker.on('client', function (client) {
    client.conn.on('drain', () => {
      t.pass('client closed ok')
    })
    client.close()
    // add back to test if there is duplicated close() call
    client.conn.on('drain', () => {
      t.fail('double client close calls')
    })
  })
})

test('not duplicate client close when double close() called', function (t) {
  t.plan(1)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  connect(setup(broker))
  broker.on('clientReady', function (client) {
    client.conn.on('drain', () => {
      t.pass('client closed ok')
    })
    client.close()
    // add back to test if there is duplicated close() call
    client.conn.on('drain', () => {
      t.fail('double execute client close function')
    })
    client.close()
  })
})
