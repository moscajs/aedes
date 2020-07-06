'use strict'

const { test } = require('tap')
const { setup, connect, subscribe, noError } = require('./helper')
const aedes = require('../')

test('publish direct to a single client QoS 0', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  broker.on('client', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('publish direct to a single client throws error', function (t) {
  t.plan(1)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.persistence.outgoingEnqueue = function (sub, packet, done) {
    done(new Error('Throws error'))
  }

  broker.on('client', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1,
      retain: false
    }, function (err) {
      t.pass('Throws error', err.message, 'throws error')
    })
  })

  connect(setup(broker), { clean: false })
})

test('publish direct to a single client throws error 2', function (t) {
  t.plan(1)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.persistence.outgoingUpdate = function (client, packet, done) {
    done(new Error('Throws error'), client, packet)
  }

  broker.on('client', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1,
      retain: false
    }, () => {})

    client.once('error', function (err) {
      t.pass('Throws error', err.message, 'throws error')
    })
  })

  connect(setup(broker), { clean: false })
})

test('publish direct to a single client QoS 1', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }

  broker.on('client', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    expected.messageId = packet.messageId
    t.deepEqual(packet, expected, 'packet matches')
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  })
})

test('publish QoS 2 throws error in pubrel', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = connect(setup(broker))

  broker.on('clientError', function (c, err) {
    t.pass('throws error')
  })

  s.outStream.on('data', function (packet) {
    if (packet.cmd === 'publish') {
      s.inStream.write({
        cmd: 'pubrec',
        messageId: packet.messageId
      })
      s.broker.persistence.outgoingUpdate = function (client, pubrel, cb) {
        cb(new Error('error'))
      }
    }
  })

  broker.on('clientReady', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
    })
  })
})

test('publish direct to a single client QoS 2', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var publishCount = 0
  var nonPublishCount = 0

  broker.on('clientReady', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
    })
    client.on('error', function (err) {
      t.error(err)
    })
  })

  const s = connect(setup(broker))

  s.inStream.on('close', () => {
    t.equal(publishCount, 1)
    t.equal(nonPublishCount, 1)
  })

  s.outStream.on('data', function (packet) {
    if (packet.cmd === 'publish') {
      publishCount++
      s.inStream.write({
        cmd: 'pubrec',
        messageId: packet.messageId
      })
    } else {
      nonPublishCount++
      s.inStream.write({
        cmd: 'pubcomp',
        messageId: packet.messageId
      })
      s.inStream.destroy()
    }
  })
})

test('emit a `ack` event on PUBACK for QoS 1 [clean=false]', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    retain: false,
    dup: false
  }

  broker.on('clientReady', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    expected.brokerId = packet.brokerId
    expected.brokerCounter = packet.brokerCounter
    expected.messageId = packet.messageId
    t.deepEqual(packet, expected, 'ack packet is origianl packet')
    t.pass('got the ack event')
  })

  const s = connect(setup(broker), { clean: false })

  s.outStream.once('data', function (packet) {
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  })
})

test('emit a `ack` event on PUBACK for QoS 1 [clean=true]', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('clientReady', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    t.equal(packet, undefined, 'ack packet is undefined')
    t.pass('got the ack event')
  })

  const s = connect(setup(broker), { clean: true })

  s.outStream.once('data', function (packet) {
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  })
})

test('emit a `ack` event on PUBCOMP for QoS 2 [clean=false]', function (t) {
  t.plan(5)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var messageId
  var clientId

  broker.on('clientReady', function (client) {
    clientId = client.id
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    t.equal(client.id, clientId)
    t.equal(packet.messageId, messageId)
    t.equal(packet.cmd, 'pubrel', 'ack packet is purel')
    t.pass('got the ack event')
  })

  const s = connect(setup(broker), { clean: false })

  s.outStream.on('data', function (packet) {
    if (packet.cmd === 'publish') {
      s.inStream.write({
        cmd: 'pubrec',
        messageId: packet.messageId
      })
    } else {
      messageId = packet.messageId
      s.inStream.write({
        cmd: 'pubcomp',
        messageId: packet.messageId
      })
    }
  })
})

test('emit a `ack` event on PUBCOMP for QoS 2 [clean=true]', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('clientReady', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    t.equal(packet, undefined, 'ack packet is undefined')
    t.pass('got the ack event')
  })

  const s = connect(setup(broker), { clean: true })

  s.outStream.on('data', function (packet) {
    if (packet.cmd === 'publish') {
      s.inStream.write({
        cmd: 'pubrec',
        messageId: packet.messageId
      })
    } else {
      s.inStream.write({
        cmd: 'pubcomp',
        messageId: packet.messageId
      })
    }
  })
})

test('offline message support for direct publish', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }
  const opts = {
    clean: false,
    clientId: 'abcde'
  }

  broker.once('client', function (client) {
    client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  var s = connect(setup(broker), opts)

  s.outStream.once('data', function (packet) {
    s = connect(setup(broker), opts)

    s.outStream.once('data', function (packet) {
      s = connect(setup(broker), opts)
      s.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})

test('subscribe a client programmatically', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('subscribe throws error when QoS > 0', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('clientReady', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 1
    }, function (err) {
      t.error(err, 'no error')

      // makes writeQos throw error
      client.connected = false
      client.connecting = false

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 1
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  broker.on('clientError', function (client, error) {
    t.equal(error.message, 'connection closed', 'should throw clientError')
  })

  connect(setup(broker))
})

test('subscribe a client programmatically - wildcard', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello/world/1',
    payload: Buffer.from('world'),
    dup: false,
    length: 20,
    qos: 0,
    retain: false
  }

  broker.on('clientReady', function (client) {
    client.subscribe({
      topic: '+/world/1',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello/world/1',
        payload: Buffer.from('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('unsubscribe a client', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')
      client.unsubscribe([{
        topic: 'hello',
        qos: 0
      }], function (err) {
        t.error(err, 'no error')
      })
    })
  })
  connect(setup(broker))
})

test('unsubscribe should not call removeSubscriptions when [clean=true]', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.persistence.removeSubscriptions = function (client, subs, cb) {
    cb(Error('remove subscription is called'))
  }

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
      client.unsubscribe({
        unsubscriptions: [{
          topic: 'hello',
          qos: 1
        }],
        messageId: 42
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })
  connect(setup(broker), { clean: true })
})

test('unsubscribe throws error', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')
      broker.unsubscribe = function (topic, func, done) {
        done(new Error('error'))
      }
      client.unsubscribe({
        topic: 'hello',
        qos: 0
      }, function () {
        t.pass('throws error')
      })
    })
  })
  connect(setup(broker))
})

test('unsubscribe throws error 2', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
      broker.persistence.removeSubscriptions = function (client, unsubscriptions, done) {
        done(new Error('error'))
      }
      client.unsubscribe({
        unsubscriptions: [{
          topic: 'hello',
          qos: 2
        }],
        messageId: 42
      }, function () {
        t.pass('throws error')
      })
    })
  })
  connect(setup(broker))
})

test('subscribe a client programmatically multiple topics', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  broker.on('client', function (client) {
    client.subscribe([{
      topic: 'hello',
      qos: 0
    }, {
      topic: 'aaa',
      qos: 0
    }], function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('subscribe a client programmatically with full packet', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  broker.on('client', function (client) {
    client.subscribe({
      subscriptions: [{
        topic: 'hello',
        qos: 0
      }, {
        topic: 'aaa',
        qos: 0
      }]
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  const s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('get message when client connects', function (t) {
  t.plan(2)

  const client1 = 'gav'
  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('client', function (client) {
    client.subscribe({
      subscriptions: [{
        topic: '$SYS/+/new/clients',
        qos: 0
      }]
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  const s1 = connect(setup(broker), { clientId: client1 })

  s1.outStream.on('data', function (packet) {
    t.equal(client1, packet.payload.toString())
  })
})

test('get message when client disconnects', function (t) {
  t.plan(2)

  const client1 = 'gav'
  const client2 = 'friend'
  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.on('client', function (client) {
    if (client.id === client1) {
      client.subscribe({
        subscriptions: [{
          topic: '$SYS/+/disconnect/clients',
          qos: 0
        }]
      }, function (err) {
        t.error(err, 'no error')
      })
    } else {
      client.close()
    }
  })

  const s1 = connect(setup(broker), { clientId: client1 })
  connect(setup(broker), { clientId: client2 })

  s1.outStream.on('data', function (packet) {
    t.equal(client2, packet.payload.toString())
  })
})

test('should not receive a message on negated subscription', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  broker.authorizeSubscribe = function (client, sub, callback) {
    callback(null, null)
  }

  broker.on('client', function (client) {
    broker.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0,
      retain: true
    }, function (err) {
      t.error(err, 'no error')
      client.subscribe([{
        topic: 'hello',
        qos: 0
      },
      {
        topic: 'hello',
        qos: 0
      }], function (err) {
        t.error(err, 'no error')
      })
    })
  })

  broker.on('subscribe', function (subs) {
    t.pass(subs.length, 1, 'Should dedupe subs')
    t.pass(subs[0].qos, 128, 'Qos should be 128 (Fail)')
  })

  const s = connect(setup(broker))
  s.outStream.once('data', function (packet) {
    t.fail('Packet should not be received')
  })
})

test('programmatically add custom subscribe', function (t) {
  t.plan(6)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = connect(setup(broker))
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }
  var deliverP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false
  }
  subscribe(t, s, 'hello', 0, function () {
    broker.subscribe('hello', deliver, function () {
      t.pass('subscribed')
    })
    s.outStream.on('data', function (packet) {
      t.deepEqual(packet, expected, 'packet matches')
    })
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 0,
      messageId: 42
    })
  })
  function deliver (packet, cb) {
    deliverP.brokerId = s.broker.id
    deliverP.brokerCounter = s.broker.counter
    t.deepEqual(packet, deliverP, 'packet matches')
    cb()
  }
})

test('custom function in broker.subscribe', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    retain: false,
    dup: false,
    messageId: undefined
  }
  connect(s, {}, function () {
    broker.subscribe('hello', deliver, function () {
      t.pass('subscribed')
    })
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 42
    })
  })
  broker.on('publish', function (packet, client) {
    if (client) {
      t.equal(packet.topic, 'hello')
      t.equal(packet.messageId, 42)
    }
  })
  function deliver (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    t.deepEqual(packet, expected, 'packet matches')
    cb()
  }
})

test('custom function in broker.unsubscribe', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = noError(setup(broker))
  connect(s, {}, function () {
    broker.subscribe('hello', deliver, function () {
      t.pass('subscribed')
      broker.unsubscribe('hello', deliver, function () {
        t.pass('unsubscribe')
        s.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'word',
          qos: 1,
          messageId: 42
        })
      })
    })
  })
  broker.on('publish', function (packet, client) {
    if (client) {
      t.pass('publish')
    }
  })
  function deliver (packet, cb) {
    t.fail('should not be called')
    cb()
  }
})
