'use strict'

var test = require('tape').test
var helper = require('./helper')
var persistence = helper.persistence
var aedes = helper.aedes
var setup = helper.setup
var connect = helper.connect

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

  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(setup(),
    opts,
    function () {
      s.conn.destroy()
    })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.deepEqual(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    cb()
    t.end()
  })
})

test('calling close two times should not deliver two wills', function (t) {
  t.plan(4)

  var opts = {}
  var broker = aedes()

  broker.on('client', function (client) {
    client.close()
    client.close()
  })

  broker.mq.on('mywill', onWill)

  // willConnect populates opts with a will
  willConnect(setup(broker), opts)

  function onWill (packet, cb) {
    broker.mq.removeListener('mywill', onWill)
    broker.mq.on('mywill', t.fail.bind(t))
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.deepEqual(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    cb()
  }
})

test('delivers old will in case of a crash', function (t) {
  t.plan(7)

  var myPersistence = persistence()
  var will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  myPersistence.broker = {
    id: 'anotherBroker'
  }

  myPersistence.putWill({
    id: 'myClientId42'
  }, will, function (err) {
    t.error(err, 'no error')

    var interval = 10 // ms, so that the will check happens fast!
    var broker = aedes({
      persistence: myPersistence,
      heartbeatInterval: interval
    })
    var start = Date.now()

    broker.mq.on('mywill', check)

    function check (packet, cb) {
      broker.mq.removeListener('mywill', check)
      t.ok(Date.now() - start >= 3 * interval, 'the will needs to be emitted after 3 heartbeats')
      t.equal(packet.topic, will.topic, 'topic matches')
      t.deepEqual(packet.payload, will.payload, 'payload matches')
      t.equal(packet.qos, will.qos, 'qos matches')
      t.equal(packet.retain, will.retain, 'retain matches')
      broker.mq.on('mywill', function (packet) {
        t.fail('the will must be delivered only once')
      })
      setImmediate(function () {
        broker.close(t.pass.bind(t, 'server closes'))
      })
      cb()
    }
  })
})

test('store the will in the persistence', function (t) {
  t.plan(5)

  var opts = {
    clientId: 'abcde'
  }

  // willConnect populates opts with a will
  var s = willConnect(setup(), opts)

  s.broker.on('client', function () {
    // this is connack
    s.broker.persistence.getWill({
      id: opts.clientId
    }, function (err, packet) {
      t.error(err, 'no error')
      t.deepEqual(packet.topic, opts.will.topic, 'will topic matches')
      t.deepEqual(packet.payload, opts.will.payload, 'will payload matches')
      t.deepEqual(packet.qos, opts.will.qos, 'will qos matches')
      t.deepEqual(packet.retain, opts.will.retain, 'will retain matches')
      t.end()
    })
  })
})

test('delete the will in the persistence after publish', function (t) {
  t.plan(2)

  var opts = {
    clientId: 'abcde'
  }

  var broker = aedes()

  broker.on('client', function (client) {
    setImmediate(function () {
      client.close()
    })
  })

  broker.mq.on('mywill', check)

  // willConnect populates opts with a will
  willConnect(setup(broker), opts)

  function check (packet, cb) {
    broker.mq.removeListener('mywill', check)
    setImmediate(function () {
      broker.persistence.getWill({
        id: opts.clientId
      }, function (err, p) {
        t.error(err, 'no error')
        t.notOk(p, 'packet is empty')
        t.end()
      })
    })
    cb()
  }
})

test('delivers a will with authorization', function (t) {
  t.plan(7)

  let authorized = false
  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(
    setup(aedes({ authorizePublish: (_1, _2, callback) => { authorized = true; callback(null) } })),
    opts,
    function () {
      s.conn.destroy()
    })

  s.broker.on('clientDisconnect', function (client) {
    t.equal(client.connected, false)
    t.equal(client.disconnected, true)
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.deepEqual(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    t.equal(authorized, true, 'authorization called')
    cb()
  })

  s.broker.on('closed', t.end.bind(t))
})

test('delivers a will waits for authorization', function (t) {
  t.plan(6)

  let authorized = false
  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(
    setup(aedes({ authorizePublish: (_1, _2, callback) => { authorized = true; setImmediate(() => { callback(null) }) } })),
    opts,
    function () {
      s.conn.destroy()
    })

  s.broker.on('clientDisconnect', function () {
    t.pass('client is disconnected')
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.deepEqual(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    t.equal(authorized, true, 'authorization called')
    cb()
  })

  s.broker.on('closed', t.end.bind(t))
})

test('does not deliver a will without authorization', function (t) {
  t.plan(1)

  let authorized = false
  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(
    setup(aedes({ authorizePublish: (_1, _2, callback) => { authorized = true; callback(new Error()) } })),
    opts,
    function () {
      s.conn.destroy()
    })

  s.broker.on('clientDisconnect', function () {
    t.equal(authorized, true, 'authorization called')
    t.end()
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail('received will without authorization')
    cb()
  })
})

test('does not deliver a will without authentication', function (t) {
  t.plan(1)

  let authenticated = false
  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(
    setup(aedes({ authenticate: (_1, _2, _3, callback) => { authenticated = true; callback(new Error(), false) } })),
    opts)

  s.broker.once('clientError', function () {
    t.equal(authenticated, true, 'authentication called')
    t.end()
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail('received will without authentication')
    cb()
  })
})

test('does not deliver will if keepalive is triggered during authentication', function (t) {
  t.plan(0)

  var opts = {}
  opts.keepalive = 1
  var broker = aedes({
    authenticate: function (c, u, p, cb) {
      setTimeout(function () {
        cb(null, true)
      }, 3000)
    }
  })

  broker.on('keepaliveTimeout', function () {
    t.end()
  })

  broker.mq.on('mywill', function (packet, cb) {
    cb()
    t.fail('Received will when it was not expected')
  })

  willConnect(setup(broker), opts)
})

// [MQTT-3.14.4-1]
test('does not deliver will when client sends a DISCONNECT', function (t) {
  t.plan(0)

  var broker = aedes()
  var s = willConnect(setup(broker), {}, function () {
    s.inStream.end({
      cmd: 'disconnect'
    })
  })

  s.broker.mq.on('mywill', function (packet, cb) {
    t.fail(packet)
  })

  broker.on('closed', t.end.bind(t))
})

test('does not store multiple will with same clientid', function (t) {
  var opts = { clientId: 'abcde' }

  var broker = aedes()

  var s = willConnect(setup(broker, false), opts, function () {
    // gracefully close client so no will is sent
    s.inStream.end({
      cmd: 'disconnect'
    })
  })

  broker.on('clientDisconnect', function (c) {
    // reconnect same client with will
    s = willConnect(setup(broker, false), opts, function () {
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

  broker.on('closed', t.end.bind(t))
})
