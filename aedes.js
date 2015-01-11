
var mqemitter       = require('mqemitter')
  , mqtt            = require('mqtt-connection')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
  , through         = require('through2')
  , EE              = require('events').EventEmitter

module.exports = aedes

function aedes() {

  var broker = mqemitter()
    , ee     = new EE()

  ee.broker = broker
  ee.handle = handle

  return ee

  function handle(conn) {
    var inStream  = conn.pipe(parseStream())
      , outStream = generateStream()
      , client    = through.obj(process)

    client.out = outStream

    outStream.pipe(conn)

    inStream.pipe(client)
  }

  function process(packet, enc, done) {
    this.out.write({
        cmd: 'connack'
      , returnCode: 0
    }, done)
  }
}
