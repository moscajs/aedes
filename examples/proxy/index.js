'use strict'

var aedes = require('../../aedes')
var mqemitter = require('mqemitter')
var persistence = require('aedes-persistence')
var mqttPacket = require('mqtt-packet')
var net = require('net')
var proxyProtocol = require('proxy-protocol-js')

function sendProxyPacket (version = 1) {
  var packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: `my-client-${version}`,
    keepalive: 0
  }

  var protocol
  if (version === 1) {
    var src = new proxyProtocol.Peer('127.0.0.1', 12345)
    var dst = new proxyProtocol.Peer('127.0.0.1', 1883)
    protocol = new proxyProtocol.V1BinaryProxyProtocol(
      proxyProtocol.INETProtocol.TCP4,
      src,
      dst,
      mqttPacket.generate(packet)
    ).build()
  } else if (version === 2) {
    protocol = new proxyProtocol.V2ProxyProtocol(
      proxyProtocol.Command.LOCAL,
      proxyProtocol.TransportProtocol.DGRAM,
      new proxyProtocol.IPv4ProxyAddress(
        proxyProtocol.IPv4Address.createFrom([127, 0, 0, 1]),
        12346,
        proxyProtocol.IPv4Address.createFrom([127, 0, 0, 1]),
        1883
      ),
      mqttPacket.generate(packet)
    ).build()
  }

  var parsedProto = version === 1
    ? proxyProtocol.V1BinaryProxyProtocol.parse(protocol)
    : proxyProtocol.V2ProxyProtocol.parse(protocol)
  // console.log(parsedProto)

  var dstPort = version === 1
    ? parsedProto.destination.port
    : parsedProto.proxyAddress.destinationPort

  var dstHost = version === 1
    ? parsedProto.destination.ipAddress
    : parsedProto.proxyAddress.destinationAddress.address.join('.')

  // console.log('Connection to :', dstHost, dstPort)
  var mqttConn = net.createConnection(
    {
      port: dstPort,
      host: dstHost,
      timeout: 150
    }
  )

  var data
  if (version === 2) {
    data = Buffer.from(protocol.buffer)
  } else {
    data = protocol
  }

  mqttConn.on('timeout', function () {
    // console.log("protocol proxy buffer", data)
    mqttConn.write(data, () => {
      mqttConn.end()
    })
  })
}

function startAedes () {
  var port = 1883

  var broker = aedes({
    mq: mqemitter({
      concurrency: 100
    }),
    persistence: persistence(),
    preConnect: function (client, done) {
      console.log('Aedes preConnect check client ip:', client.connDetails)
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
      }
      client.close()
      return done(null, true)
    },
    trustProxy: true
  })

  var server = require('net').createServer(broker.handle)

  server.listen(port, function () {
    console.log('Aedes listening on port:', port)
    broker.publish({ topic: 'aedes/hello', payload: "I'm broker " + broker.id })
    setTimeout(() => sendProxyPacket(1), 250)
    setTimeout(() => sendProxyPacket(2), 500)
  })

  broker.on('subscribe', function (subscriptions, client) {
    console.log('MQTT client \x1b[32m' + (client ? client.id : client) +
            '\x1b[0m subscribed to topics: ' + subscriptions.map(s => s.topic).join('\n'), 'from broker', broker.id)
  })

  broker.on('unsubscribe', function (subscriptions, client) {
    console.log('MQTT client \x1b[32m' + (client ? client.id : client) +
            '\x1b[0m unsubscribed to topics: ' + subscriptions.join('\n'), 'from broker', broker.id)
  })

  // fired when a client connects
  broker.on('client', function (client) {
    console.log('Client Connected: \x1b[33m' + (client ? client.id : client) + ' ip  ' + (client ? client.ip : null) + '\x1b[0m', 'to broker', broker.id)
  })

  // fired when a client disconnects
  broker.on('clientDisconnect', function (client) {
    console.log('Client Disconnected: \x1b[31m' + (client ? client.id : client) + '\x1b[0m', 'to broker', broker.id)
  })

  // fired when a message is published
  broker.on('publish', async function (packet, client) {
    console.log('Client \x1b[31m' + (client ? client.id : 'BROKER_' + broker.id) + '\x1b[0m has published', packet.payload.toString(), 'on', packet.topic, 'to broker', broker.id)
  })
}

startAedes()
