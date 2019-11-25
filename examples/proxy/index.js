var mqemitter = require('mqemitter')
var persistence = require('aedes-persistence')
var mqttPacket = require('mqtt-packet')
var net = require('net')
var proxyProtocol = require('proxy-protocol-js')

function sendProxyPacket () {
  var packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  }

  var data = mqttPacket.generate(packet)
  console.log(data)

  var src = new proxyProtocol.Peer('127.0.0.1', 12345)
  var dst = new proxyProtocol.Peer('127.0.0.1', 1883)
  var protocol = new proxyProtocol.V1BinaryProxyProtocol(
    proxyProtocol.INETProtocol.TCP4,
    src,
    dst,
    data
  ).build()

  console.log(protocol)

  var parsedProto = proxyProtocol.V1BinaryProxyProtocol.parse(protocol)
  console.log(parsedProto)

  var mqttConn = net.createConnection(
    {
      port: parsedProto.destination.port,
      host: parsedProto.destination.ipAddress,
      // localAddress: proto.source.ipAddress,
      // localPort: proto.source.port,
      // family: parsedProto.ipFamily,
      // lookup,
      timeout: 300
    }
  )

  mqttConn.on('timeout', function () {
    mqttConn.write(protocol)
    mqttConn.end()
  })
}

function startAedes () {
  var port = 1883

  var aedes = require('aedes')({
    mq: mqemitter({
      concurrency: 100
    }),
    persistence: persistence(),
    preConnect: function (client, done) {
      // check client.ipAddress
      console.log('Aedes preConnect check client ip:', client.ipAddress)
      client.ip = client.ipAddress
      return done()
    },
    trustProxy: true
  })

  var server = require('net').createServer(aedes.handle)

  server.listen(port, function () {
    console.log('Aedes listening on port:', port)
    aedes.publish({ topic: 'aedes/hello', payload: "I'm broker " + aedes.id })
    sendProxyPacket()
  })

  aedes.on('subscribe', function (subscriptions, client) {
    console.log('MQTT client \x1b[32m' + (client ? client.id : client) +
            '\x1b[0m subscribed to topics: ' + subscriptions.map(s => s.topic).join('\n'), 'from broker', aedes.id)
  })

  aedes.on('unsubscribe', function (subscriptions, client) {
    console.log('MQTT client \x1b[32m' + (client ? client.id : client) +
            '\x1b[0m unsubscribed to topics: ' + subscriptions.join('\n'), 'from broker', aedes.id)
  })

  // fired when a client connects
  aedes.on('client', function (client) {
    console.log('Client Connected: \x1b[33m' + (client ? client.id : client) + '-' + (client ? client.ipAddress : null) + '\x1b[0m', 'to broker', aedes.id)
  })

  // fired when a client disconnects
  aedes.on('clientDisconnect', function (client) {
    console.log('Client Disconnected: \x1b[31m' + (client ? client.id : client) + '\x1b[0m', 'to broker', aedes.id)
  })

  // fired when a message is published
  aedes.on('publish', async function (packet, client) {
    console.log('Client \x1b[31m' + (client ? client.id : 'BROKER_' + aedes.id) + '\x1b[0m has published', packet.payload.toString(), 'on', packet.topic, 'to broker', aedes.id)
  })
}

startAedes()
