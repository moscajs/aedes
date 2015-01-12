
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
      inStream: inStream
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
    if (packet.cmd !== 'connack') {
      this.push(packet)
    }
    cb()
  }
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
        , dup: false
        , length: 12
        , qos: 0
        , retain: false
      }

  s.broker.mq.on('hello', function(packet, cb) {
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

  s.outStream.once('data', function(packet, cb) {
    t.deepEqual(packet, {
        cmd: 'suback'
      , messageId: 42
      , dup: false
      , granted: [0]
      , length: 3
      , qos: 0
      , retain: false
    })

    this.once('data', function(packet, cb) {
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
