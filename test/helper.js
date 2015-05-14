
var mqtt            = require('mqtt-connection')
  , through         = require('through2')
  , aedes           = require('../')
  , reduplexer      = require('reduplexer')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
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

module.exports = {
    setup: setup
  , connect: connect
  , noError: noError
}
