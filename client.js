
var mqtt            = require('mqtt-connection')
  , parseStream     = mqtt.parseStream
  , generateStream  = mqtt.generateStream
  , through         = require('through2')

module.exports = Client

function Client(broker, conn) {
  var processor     = through.obj(process)

  this.broker       = broker
  this.conn         = conn
  this.outStream    = generateStream()
  this.inStream     = conn.pipe(parseStream())
  this.connected    = false

  processor.client  = this

  this.outStream.pipe(conn)

  this.inStream.pipe(processor)
}

function process(packet, enc, done) {
  var client = this.client
    , broker = this.client.broker

  if (packet.cmd !== 'connect' && !client.connected) {
    client.conn.destroy()
    return
  }

  switch (packet.cmd) {
    case 'connect':
      client.connected = true
      client.outStream.write({
          cmd: 'connack'
        , returnCode: 0
      }, done)
      break
    case 'publish':
      broker.publish(packet, done)
      break
    case 'subscribe':
      broker.subscribe(packet, function(packet, cb) {
        client.outStream.write(packet, cb)
      }, function(err) {
        // TODO handle err?

        var response = {
              cmd: 'suback'
            , messageId: 42
            , granted: packet.subscriptions.map(function() {
                // everything subscribed to QoS 0
                return 0
              })
          }

        client.outStream.write(response, done)
      })
      break
    default:
      client.conn.destroy()
      return
  }
}
