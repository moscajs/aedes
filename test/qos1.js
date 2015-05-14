
var test      = require('tape').test
  , helper    = require('./helper')
  , aedes     = require('../')
  , setup     = helper.setup
  , connect   = helper.connect
  , noError   = helper.noError

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

test('remove stored subscriptions if connected with clean=true', function(t) {
  var broker      = aedes()
    , publisher
    , subscriber  = connect(setup(broker), { clean: false, clientId: 'abcde' })
    , publish     = {
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

    subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' }, function(packet) {
      t.equal(packet.sessionPresent, false, 'session present is set to false')
      publisher.inStream.write({
          cmd: 'publish'
        , topic: 'hello'
        , payload: 'world'
        , qos: 1
        , messageId: 42
      })

      subscriber.inStream.end()

      subscriber = connect(setup(broker), { clean: false, clientId: 'abcde' }, function(connect) {
        t.equal(connect.sessionPresent, false, 'session present is set to false')
        publisher.inStream.write({
            cmd: 'publish'
          , topic: 'hello'
          , payload: 'world'
          , qos: 1
          , messageId: 43
        })

        t.end()
      })

      subscriber.outStream.once('data', function(packet) {
        t.fail('publish received')
      })
    })

    subscriber.outStream.once('data', function(packet) {
      t.fail('publish received')
    })
  })
})

test('subscribe QoS 1 not clean', function(t) {
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

test('do not resend QoS 1 packets at each reconnect', function(t) {
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
        subscriber.inStream.end({
            cmd: 'puback'
          , messageId: packet.messageId
        })

        t.notEqual(packet.messageId, 42, 'messageId must differ')
        delete packet.messageId
        t.deepEqual(packet, expected, 'packet must match')

        var subscriber2 = connect(setup(broker), { clean: false, clientId: 'abcde' })

        subscriber2.outStream.once('data', function(packet) {
          t.fail('this should never happen')
        })

        // TODO wait all packets to be sent
        setTimeout(function() {
          t.end()
        }, 50)
      })
    })
  })
})

test('do not resend QoS 1 packets if reconnect is clean', function(t) {
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

      subscriber = connect(setup(broker), { clean: true, clientId: 'abcde' })

      subscriber.outStream.once('data', function(packet) {
        t.fail('this should never happen')
      })

      // TODO wait all packets to be sent
      setTimeout(function() {
        t.end()
      }, 50)
    })
  })
})
