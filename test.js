
var test            = require('tape').test
  , mqtt            = require('mqtt-connection')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
  , through         = require('through2')
  , reduplexer      = require('reduplexer')
  , aedes           = require('./')

function setup() {
  var broker    = aedes()
    , inStream  = generateStream()
    , outStream = parseStream()
    , conn      = reduplexer(outStream, inStream)

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

function connect(s) {
  s = Object.create(s)
  s.outStream = s.outStream.pipe(through.obj(filter))

  s.inStream.write({
      cmd: 'connect'
    , protocolId: 'MQTT'
    , protocolVersion: 4
    , clean: true
    , clientId: 'my-client'
    , keepalive: 0
  })

  return s

  function filter(packet, enc, cb) {
    if (packet.cmd !== 'publish') {
      delete packet.topic
      delete packet.payload
    }
    if (packet.cmd !== 'connack') {
      this.push(packet)
    }
    cb()
  }
}

function noError(s, t) {
  s.broker.on('clientError', function(client, err) {
    console.log(err)
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
