
var test            = require('tape').test
  , mqtt            = require('mqtt-connection')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
  , through         = require('through2')
  , reduplexer      = require('reduplexer')
  , aedes           = require('./')

test('connect and connack (minimal)', function(t) {
  var broker    = aedes()
    , inStream  = generateStream()
    , outStream = parseStream()
    , conn      = reduplexer(outStream, inStream)

  inStream.write({
      cmd: 'connect'
    , protocolId: 'MQTT'
    , protocolVersion: 4
    , clean: true
    , clientId: 'my-client'
    , keepalive: 0
  })

  outStream.on('data', function(packet) {
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

  broker.handle(conn)
})
