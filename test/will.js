'use strict'

const { test } = require('tap')
const memory = require('aedes-persistence')
const Faketimers = require('@sinonjs/fake-timers')
const { setup, connect, noError } = require('./helper')
const aedes = require('../')

function willConnect (s, opts, connected) {
  opts = opts || {}
  opts.will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  return connect(s, opts, connected)
}

test('delivers a will', function (t) {
  t.plan(4)

  const opts = {}
  // willConnect populates opts with a will
  const s = willConnect(setup(),
    opts,
    function () {
      s.conn.destroy()
    }
  )
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.same(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    cb()
  })
})

test('calling close two times should not deliver two wills', function (t) {
  t.plan(4)

  const opts = {}
  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('client', function (client) {
    client.close()
    client.close()
  })

  broker.mq.on('mywill', onWill)

  // willConnect populates opts with a will
  willConnect(setup(broker), opts)

  function onWill (packet, cb) {
    broker.mq.removeListener('mywill', onWill, function () {
      broker.mq.on('mywill', function (packet) {
        t.fail('the will must be delivered only once')
      })
    })
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.same(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    cb()
  }
})

test('delivers old will in case of a crash', function (t) {
  t.plan(8)

  const persistence = memory()
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  persistence.broker = {
    id: 'anotherBroker'
  }

  persistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    let authorized = false
    const interval = 10 // ms, so that the will check happens fast!
    const broker = aedes({
      persistence,
      heartbeatInterval: interval,
      authorizePublish: function (client, packet, callback) {
        t.strictSame(client, null, 'client must be null')
        authorized = true
        callback(null)
      }
    })
    t.teardown(broker.close.bind(broker))

    const start = Date.now()

    broker.mq.on('mywill', check)

    function check (packet, cb) {
      broker.mq.removeListener('mywill', check, function () {
        broker.mq.on('mywill', function (packet) {
          t.fail('the will must be delivered only once')
        })
      })
      t.ok(Date.now() - start >= 3 * interval, 'the will needs to be emitted after 3 heartbeats')
      t.equal(packet.topic, will.topic, 'topic matches')
      t.same(packet.payload, will.payload, 'payload matches')
      t.equal(packet.qos, will.qos, 'qos matches')
      t.equal(packet.retain, will.retain, 'retain matches')
      t.equal(authorized, true, 'authorization called')
      cb()
    }
  })
})

test('deliver old will without authorization in case of a crash', function (t) {
  t.plan(2)

  const persistence = memory()
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  persistence.broker = {
    id: 'anotherBroker'
  }

  persistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    const interval = 10 // ms, so that the will check happens fast!
    const broker = aedes({
      persistence,
      heartbeatInterval: interval,
      authorizePublish: function (client, packet, callback) {
        t.strictSame(client, null, 'client must be null')
        callback(new Error())
      }
    })

    t.teardown(broker.close.bind(broker))

    broker.mq.on('mywill', check)

    function check (packet, cb) {
      t.fail('received will without authorization')
      cb()
    }
  })
})

test('delete old broker', function (t) {
  t.plan(1)

  const clock = Faketimers.install()

  const heartbeatInterval = 100
  const broker = aedes({
    heartbeatInterval
  })
  t.teardown(broker.close.bind(broker))

  const brokerId = 'dummyBroker'

  broker.brokers[brokerId] = Date.now() - heartbeatInterval * 3.5

  setTimeout(() => {
    t.equal(broker.brokers[brokerId], undefined, 'Broker deleted')
  }, heartbeatInterval * 4)

  clock.tick(heartbeatInterval * 4)

  clock.uninstall()
})

test('store the will in the persistence', function (t) {
  t.plan(5)

  const opts = {
    clientId: 'abcde'
  }

  // willConnect populates opts with a will
  const s = willConnect(setup(), opts)
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('client', function () {
    // this is connack
    s.broker.persistence.getWill({
      id: opts.clientId
    }, function (err, packet) {
      t.error(err, 'no error')
      t.same(packet.topic, opts.will.topic, 'will topic matches')
      t.same(packet.payload, opts.will.payload, 'will payload matches')
      t.same(packet.qos, opts.will.qos, 'will qos matches')
      t.same(packet.retain, opts.will.retain, 'will retain matches')
    })
  })
})

test('delete the will in the persistence after publish', function (t) {
  t.plan(2)

  const opts = {
    clientId: 'abcde'
  }

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  broker.on('client', function (client) {
    setImmediate(function () {
      client.close()
    })
  })

  broker.mq.on('mywill', check)

  // willConnect populates opts with a will
  willConnect(setup(broker), opts)

  function check (packet, cb) {
    broker.mq.removeListener('mywill', check, function () {
      broker.persistence.getWill({
        id: opts.clientId
      }, function (err, p) {
        t.error(err, 'no error')
        t.notOk(p, 'packet is empty')
      })
    })
    cb()
  }
})

test('delivers a will with authorization', function (t) {
  t.plan(6)

  let authorized = false
  const opts = {}
  // willConnect populates opts with a will
  const s = willConnect(
    setup(aedes({
      authorizePublish: (client, packet, callback) => {
        authorized = true
        callback(null)
      }
    })),
    opts,
    function () {
      s.conn.destroy()
    }
  )
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientDisconnect', function (client) {
    t.equal(client.connected, false)
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.same(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    t.equal(authorized, true, 'authorization called')
    cb()
  })
})

test('delivers a will waits for authorization', function (t) {
  t.plan(6)

  let authorized = false
  const opts = {}
  // willConnect populates opts with a will
  const s = willConnect(
    setup(aedes({
      authorizePublish: (client, packet, callback) => {
        authorized = true
        setImmediate(() => { callback(null) })
      }
    })),
    opts,
    function () {
      s.conn.destroy()
    }
  )
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientDisconnect', function () {
    t.pass('client is disconnected')
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.same(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    t.equal(authorized, true, 'authorization called')
    cb()
  })
})

test('does not deliver a will without authorization', function (t) {
  t.plan(1)

  let authorized = false
  const opts = {}
  // willConnect populates opts with a will
  const s = willConnect(
    setup(aedes({
      authorizePublish: (username, packet, callback) => {
        authorized = true
        callback(new Error())
      }
    })),
    opts,
    function () {
      s.conn.destroy()
    }
  )
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientDisconnect', function () {
    t.equal(authorized, true, 'authorization called')
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail('received will without authorization')
    cb()
  })
})

test('does not deliver a will without authentication', function (t) {
  t.plan(1)

  let authenticated = false
  const opts = {}
  // willConnect populates opts with a will
  const s = willConnect(
    setup(aedes({
      authenticate: (client, username, password, callback) => {
        authenticated = true
        callback(new Error(), false)
      }
    })),
    opts
  )
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('clientError', function () {
    t.equal(authenticated, true, 'authentication called')
    t.end()
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail('received will without authentication')
    cb()
  })
})

test('does not deliver will if broker is closed during authentication', function (t) {
  t.plan(0)

  const opts = { keepalive: 1 }

  const broker = aedes({
    authenticate: function (client, username, password, callback) {
      setTimeout(function () {
        callback(null, true)
      })
      broker.close()
    }
  })

  broker.on('keepaliveTimeout', function () {
    t.fail('keepalive timer shoud not be set')
  })

  broker.mq.on('mywill', function (packet, cb) {
    t.fail('Received will when it was not expected')
    cb()
  })

  willConnect(setup(broker), opts)
})

// [MQTT-3.14.4-3]
test('does not deliver will when client sends a DISCONNECT', function (t) {
  t.plan(0)

  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = noError(willConnect(setup(broker), {}, function () {
    s.inStream.end({
      cmd: 'disconnect'
    })
  }), t)

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail(packet)
    cb()
  })
})

test('deletes from persistence on DISCONNECT', function (t) {
  t.plan(2)

  const opts = {
    clientId: 'abcde'
  }
  const broker = aedes()
  t.teardown(broker.close.bind(broker))

  const s = noError(willConnect(setup(broker), opts, function () {
    s.inStream.end({
      cmd: 'disconnect'
    })
  }), t)

  s.broker.persistence.getWill({
    id: opts.clientId
  }, function (err, packet) {
    t.error(err, 'no error')
    t.notOk(packet)
  })
})

test('does not store multiple will with same clientid', function (t) {
  t.plan(4)

  const opts = { clientId: 'abcde' }

  const broker = aedes()

  let s = noError(willConnect(setup(broker), opts, function () {
    // gracefully close client so no will is sent
    s.inStream.end({
      cmd: 'disconnect'
    })
  }), t)

  broker.on('clientDisconnect', function (client) {
    // reconnect same client with will
    s = willConnect(setup(broker), opts, function () {
      // check that there are not 2 will messages for the same clientid
      s.broker.persistence.delWill({ id: opts.clientId }, function (err, packet) {
        t.error(err, 'no error')
        t.equal(packet.clientId, opts.clientId, 'will packet found')
        s.broker.persistence.delWill({ id: opts.clientId }, function (err, packet) {
          t.error(err, 'no error')
          t.equal(!!packet, false, 'no duplicated packets')
          broker.close()
        })
      })
    })
  })
})

test('don\'t delivers a will if broker alive', function (t) {
  const persistence = memory()
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  const oldBroker = 'broker1'

  persistence.broker = {
    id: oldBroker
  }

  persistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    const opts = {
      persistence,
      heartbeatInterval: 10
    }

    let count = 0

    const broker = aedes(opts)
    t.teardown(broker.close.bind(broker))

    const streamWill = persistence.streamWill
    persistence.streamWill = function () {
      // don't pass broker.brokers to streamWill
      return streamWill.call(persistence)
    }

    broker.mq.on('mywill', function (packet, cb) {
      t.fail('Will received')
      cb()
    })

    broker.mq.on('$SYS/+/heartbeat', function () {
      t.pass('Heartbeat received')
      broker.brokers[oldBroker] = Date.now()

      if (++count === 5) {
        t.end()
      }
    })
  })
})

test('handle will publish error', function (t) {
  t.plan(2)
  const persistence = memory()
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  persistence.broker = {
    id: 'broker1'
  }

  persistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    const opts = {
      persistence,
      heartbeatInterval: 10
    }

    persistence.delWill = function (client, cb) {
      cb(new Error('Throws error'))
    }

    const broker = aedes(opts)
    t.teardown(broker.close.bind(broker))

    broker.once('error', function (err) {
      t.equal('Throws error', err.message, 'throws error')
    })
  })
})

test('handle will publish error 2', function (t) {
  t.plan(2)
  const persistence = memory()
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: true
  }

  persistence.broker = {
    id: 'broker1'
  }

  persistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    const opts = {
      persistence,
      heartbeatInterval: 10
    }

    persistence.storeRetained = function (packet, cb) {
      cb(new Error('Throws error'))
    }

    const broker = aedes(opts)
    t.teardown(broker.close.bind(broker))

    broker.once('error', function (err) {
      t.equal('Throws error', err.message, 'throws error')
    })
  })
})
