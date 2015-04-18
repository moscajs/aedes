
var test            = require('tape').test
  , mqtt            = require('mqtt-connection')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
  , through         = require('through2')
  , reduplexer      = require('reduplexer')
  , aedes           = require('../')
  , clients         = 0

function setup(broker) {
  var inStream  = generateStream()
    , outStream = parseStream()
    , conn      = reduplexer(outStream, inStream)

  broker = broker || aedes()

  broker.handle(conn)

  conn.destroy = function() {
    inStream.destroy()
    outStream.destroy()
  }

  return {
      conn: conn
    , inStream: inStream
    , outStream: outStream
    , broker: broker
  }
}

function connect(s, opts, connected) {
  s = Object.create(s)
  s.outStream = s.outStream.pipe(through.obj(filter))

  opts = opts || {}

  opts.cmd = 'connect'
  opts.protocolId = 'MQTT'
  opts.version = 4
  opts.clean = opts.clean === false ? false : true
  opts.clientId = opts.clientId || 'my-client-' + clients++
  opts.keepalive = opts.keepAlive || 0

  s.inStream.write(opts)

  return s

  function filter(packet, enc, cb) {
    if (packet.cmd !== 'publish') {
      delete packet.topic
      delete packet.payload
    }
    if (packet.cmd !== 'connack') {
      this.push(packet)
    } else if (connected) {
      connected(packet)
    }
    cb()
  }
}

function noError(s, t) {
  s.broker.on('clientError', function(client, err) {
    if (err) throw err
    t.notOk(err, 'must not error')
  })

  return s
}

test('connect and connack (minimal)', function(t) {

  var s = setup()

  s.inStream.write({
      cmd: 'connect'
    , protocolId: 'MQTT'
    , protocolVersion: 4
    , clean: true
    , clientId: 'my-client'
    , keepalive: 0
  })

  s.outStream.on('data', function(packet) {
    t.deepEqual(packet, {
        cmd: 'connack'
      , returnCode: 0
      , length: 2
      , qos: 0
      , retain: false
      , dup: false
      , topic: null
      , payload: null
      , sessionPresent: false
    }, 'successful connack')
    t.end()
  })
})

test('publish QoS 0', function(t) {
  var s         = connect(setup())
    , expected  = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 0
        , retain: false
      }

  s.broker.mq.on('hello', function(packet, cb) {
    expected.id = s.broker.id + '-' + s.broker.counter
    t.deepEqual(packet, expected, 'packet matches')
    cb()
    t.end()
  })

  s.inStream.write({
      cmd: 'publish'
    , topic: 'hello'
    , payload: 'world'
  })
})

test('subscribe QoS 0', function(t) {
  var s         = connect(setup())
    , expected  = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , dup: false
        , length: 12
        , qos: 0
        , retain: false
      }

  s.inStream.write({
      cmd: 'subscribe'
    , messageId: 42
    , subscriptions: [{
          topic: 'hello'
        , qos: 0
      }]
  })

  s.outStream.once('data', function(packet) {
    t.deepEqual(packet, {
        cmd: 'suback'
      , messageId: 42
      , dup: false
      , granted: [0]
      , length: 3
      , qos: 0
      , retain: false
    })

    this.once('data', function(packet) {
      t.deepEqual(packet, expected, 'packet matches')
      t.end()
    })

    s.broker.mq.emit({
        cmd: 'publish'
      , topic: 'hello'
      , payload: 'world'
    })
  })
})

test('does not die badly on connection error', function(t) {
  t.plan(3)
  var s         = connect(setup())

  s.inStream.write({
      cmd: 'subscribe'
    , messageId: 42
    , subscriptions: [{
          topic: 'hello'
        , qos: 0
      }]
  })

  s.broker.on('clientError', function(client, err) {
    t.ok(client, 'client is passed')
    t.ok(err, 'err is passed')
  })

  s.outStream.on('data', function(packet) {
    s.conn._writableState.ended = true
    s.broker.mq.emit({
      cmd: 'publish'
      , topic: 'hello'
      , payload: new Buffer('world')
    }, function() {
      t.pass('calls the callback')
    })
  })
})

test('unsubscribe', function(t) {
  t.plan(3)

  var s         = noError(connect(setup()), t)

  s.inStream.write({
      cmd: 'subscribe'
    , messageId: 42
    , subscriptions: [{
          topic: 'hello'
        , qos: 0
      }]
  })

  s.outStream.once('data', function(packet) {
    t.deepEqual(packet, {
        cmd: 'suback'
      , messageId: 42
      , dup: false
      , granted: [0]
      , length: 3
      , qos: 0
      , retain: false
    })

    s.inStream.write({
        cmd: 'unsubscribe'
      , messageId: 43
      , unsubscriptions: ['hello']
    })

    this.once('data', function(packet) {

      t.deepEqual(packet, {
          cmd: 'unsuback'
        , messageId: 43
        , dup: false
        , length: 2
        , qos: 0
        , retain: false
      }, 'packet matches')

      this.on('data', function(packet) {
        t.fail('packet received')
      })

      s.broker.publish({
          cmd: 'publish'
        , topic: 'hello'
        , payload: 'world'
      }, function() {
        t.pass('publish finished')
      })
    })
  })
})

test('unsubscribe on disconnect', function(t) {
  var s         = noError(connect(setup()), t)

  s.inStream.write({
      cmd: 'subscribe'
    , messageId: 42
    , subscriptions: [{
          topic: 'hello'
        , qos: 0
      }]
  })

  s.outStream.once('data', function(packet) {
    s.conn.emit('close')
    s.outStream.on('data', function() {
      t.fail('should not receive any more messages')
    })
    s.broker.mq.emit({
      cmd: 'publish'
      , topic: 'hello'
      , payload: new Buffer('world')
    }, function() {
      t.pass('calls the callback')
      t.end()
    })
  })
})

test('disconnect', function(t) {
  var s         = noError(connect(setup()), t)

  s.outStream.on('finish', function() {
    t.end()
  })

  s.inStream.write({
    cmd: 'disconnect'
  })
})

test('retain messages', function(t) {
  var broker      = aedes()
    , publisher   = connect(setup(broker))
    , subscriber  = connect(setup(broker))
    , expected    = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 0
        , dup: false
        , length: 12
        , retain: true
      }

  publisher.inStream.end({
      cmd: 'publish'
    , topic: 'hello'
    , payload: 'world'
    , retain: true
  })


  broker.mq.on('hello', function(packet, cb) {
    subscriber.inStream.write({
        cmd: 'subscribe'
      , messageId: 42
      , subscriptions: [{
            topic: 'hello'
          , qos: 0
        }]
    })
  })

  subscriber.outStream.once('data', function(packet) {
    t.equal(packet.cmd, 'suback')

    subscriber.outStream.once('data', function(packet) {
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })
  })
})

test('publish QoS 1', function(t) {
  var s         = connect(setup())
    , expected  = {
          cmd: 'puback'
        , messageId: 42
        , qos: 0
        , dup: false
        , length: 2
        , retain: false
      }

  s.inStream.write({
      cmd: 'publish'
    , topic: 'hello'
    , payload: 'world'
    , qos: 1
    , messageId: 42
  })

  s.outStream.on('data', function(packet) {
    t.deepEqual(packet, expected, 'packet must match')
    t.end()
  })
})

test('subscribe QoS 1', function(t) {
  var broker      = aedes()
    , publisher   = connect(setup(broker))
    , subscriber  = connect(setup(broker))
    , expected    = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 1
        , dup: false
        , length: 14
        , retain: false
      }

  subscriber.inStream.write({
      cmd: 'subscribe'
    , messageId: 24
    , subscriptions: [{
          topic: 'hello'
        , qos: 1
      }]
  })

  subscriber.outStream.once('data', function(packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [1])
    t.equal(packet.messageId, 24)

    subscriber.outStream.once('data', function(packet) {
      subscriber.inStream.write({
          cmd: 'puback'
        , messageId: packet.messageId
      })
      t.notEqual(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })

    publisher.inStream.write({
        cmd: 'publish'
      , topic: 'hello'
      , payload: 'world'
      , qos: 1
      , messageId: 42
    })
  })
})

test('subscribe QoS 0, but publish QoS 1', function(t) {
  var broker      = aedes()
    , publisher   = connect(setup(broker))
    , subscriber  = connect(setup(broker))
    , expected    = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 0
        , dup: false
        , length: 12
        , retain: false
      }

  subscriber.inStream.write({
      cmd: 'subscribe'
    , messageId: 24
    , subscriptions: [{
          topic: 'hello'
        , qos: 0
      }]
  })

  subscriber.outStream.once('data', function(packet) {
    t.equal(packet.cmd, 'suback')

    subscriber.outStream.once('data', function(packet) {
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })

    publisher.inStream.write({
        cmd: 'publish'
      , topic: 'hello'
      , payload: 'world'
      , qos: 1
      , messageId: 42
    })
  })
})

test('restore QoS 1 subscriptions not clean', function(t) {
  var broker      = aedes()
    , publisher
    , subscriber  = connect(setup(broker), { clean: false, clientId: 'abcde' })
    , expected    = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 1
        , dup: false
        , length: 14
        , retain: false
      }

  subscriber.inStream.write({
      cmd: 'subscribe'
    , messageId: 24
    , subscriptions: [{
          topic: 'hello'
        , qos: 1
      }]
  })

  subscriber.outStream.once('data', function(packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [1])
    t.equal(packet.messageId, 24)

    subscriber.inStream.end()

    publisher = connect(setup(broker))

    subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function(connect) {
      t.equal(connect.sessionPresent, true, 'session present is set to true')
      publisher.inStream.write({
          cmd: 'publish'
        , topic: 'hello'
        , payload: 'world'
        , qos: 1
        , messageId: 42
      })
    })

    publisher.outStream.once('data', function(packet) {
      t.equal(packet.cmd, 'puback')
    })

    subscriber.outStream.once('data', function(packet) {
      subscriber.inStream.write({
          cmd: 'puback'
        , messageId: packet.messageId
      })
      t.notEqual(packet.messageId, 42, 'messageId must differ')
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
      t.end()
    })
  })
})

test.skip('subscribe QoS 1 not clean', function(t) {
  var broker      = aedes()
    , publisher
    , subscriber  = connect(setup(broker), { clean: false, clientId: 'abcde' })
    , expected    = {
          cmd: 'publish'
        , topic: 'hello'
        , payload: new Buffer('world')
        , qos: 1
        , dup: false
        , length: 14
        , retain: false
      }

  subscriber.inStream.write({
      cmd: 'subscribe'
    , messageId: 24
    , subscriptions: [{
          topic: 'hello'
        , qos: 1
      }]
  })

  subscriber.outStream.once('data', function(packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [1])
    t.equal(packet.messageId, 24)

    subscriber.inStream.end()

    publisher = connect(setup(broker))

    publisher.inStream.write({
        cmd: 'publish'
      , topic: 'hello'
      , payload: 'world'
      , qos: 1
      , messageId: 42
    })

    publisher.outStream.once('data', function(packet) {
      t.equal(packet.cmd, 'puback')

      subscriber  = connect(setup(broker), { clean: false, clientId: 'abcde' })

      subscriber.outStream.once('data', function(packet) {
        subscriber.inStream.write({
            cmd: 'puback'
          , messageId: packet.messageId
        })
        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')
        t.end()
      })
    })
  })
})
