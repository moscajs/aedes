'use strict'

const aedes = require('../../aedes')
const mqemitter = require('mqemitter')
const persistence = require('aedes-persistence')
const mqttPacket = require('mqtt-packet')
const net = require('net')
const proxyProtocol = require('proxy-protocol-js')

const brokerPort = 4883

// from https://stackoverflow.com/questions/57077161/how-do-i-convert-hex-buffer-to-ipv6-in-javascript
function parseIpV6 (ip) {
  return ip.match(/.{1,4}/g)
    .map((val) => val.replace(/^0+/, ''))
    .join(':')
    .replace(/0000:/g, ':')
    .replace(/:{2,}/g, '::')
}

function sendProxyPacket (version = 1, ipFamily = 4) {
  const packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: `my-client-${version}`,
    keepalive: 0
  }
  const hostIpV4 = '0.0.0.0'
  const clientIpV4 = '192.168.1.128'
  const hostIpV6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const clientIpV6 = [0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 1, 128]
  var protocol
  if (version === 1) {
    if (ipFamily === 4) {
      protocol = new proxyProtocol.V1BinaryProxyProtocol(
        proxyProtocol.INETProtocol.TCP4,
        new proxyProtocol.Peer(clientIpV4, 12345),
        new proxyProtocol.Peer(hostIpV4, brokerPort),
        mqttPacket.generate(packet)
      ).build()
    } else if (ipFamily === 6) {
      protocol = new proxyProtocol.V1BinaryProxyProtocol(
        proxyProtocol.INETProtocol.TCP6,
        new proxyProtocol.Peer(parseIpV6(Buffer.from(clientIpV6).toString('hex')), 12345),
        new proxyProtocol.Peer(parseIpV6(Buffer.from(hostIpV6).toString('hex')), brokerPort),
        mqttPacket.generate(packet)
      ).build()
    }
  } else if (version === 2) {
    if (ipFamily === 4) {
      protocol = new proxyProtocol.V2ProxyProtocol(
        proxyProtocol.Command.LOCAL,
        proxyProtocol.TransportProtocol.STREAM,
        new proxyProtocol.IPv4ProxyAddress(
          proxyProtocol.IPv4Address.createFrom(clientIpV4.split('.')),
          12346,
          proxyProtocol.IPv4Address.createFrom(hostIpV4.split('.')),
          brokerPort
        ),
        mqttPacket.generate(packet)
      ).build()
    } else if (ipFamily === 6) {
      protocol = new proxyProtocol.V2ProxyProtocol(
        proxyProtocol.Command.PROXY,
        proxyProtocol.TransportProtocol.STREAM,
        new proxyProtocol.IPv6ProxyAddress(
          proxyProtocol.IPv6Address.createFrom(clientIpV6),
          12346,
          proxyProtocol.IPv6Address.createFrom(hostIpV6),
          brokerPort
        ),
        mqttPacket.generate(packet)
      ).build()
    }
  }

  const parsedProto = version === 1
    ? proxyProtocol.V1BinaryProxyProtocol.parse(protocol)
    : proxyProtocol.V2ProxyProtocol.parse(protocol)
  // console.log(parsedProto)

  const dstPort = version === 1
    ? parsedProto.destination.port
    : parsedProto.proxyAddress.destinationPort

  var dstHost
  if (version === 1) {
    if (ipFamily === 4) {
      dstHost = parsedProto.destination.ipAddress
    } else if (ipFamily === 6) {
      dstHost = parsedProto.destination.ipAddress
      // console.log('ipV6 host :', parsedProto.destination.ipAddress)
    }
  } else if (version === 2) {
    if (ipFamily === 4) {
      dstHost = parsedProto.proxyAddress.destinationAddress.address.join('.')
    } else if (ipFamily === 6) {
      // console.log('ipV6 client :', parseIpV6(Buffer.from(clientIpV6).toString('hex')))
      dstHost = parseIpV6(Buffer.from(parsedProto.proxyAddress.destinationAddress.address).toString('hex'))
    }
  }

  console.log('Connection to :', dstHost, dstPort)
  var mqttConn = net.createConnection(
    {
      port: dstPort,
      host: dstHost,
      timeout: 150
    }
  )

  const data = protocol

  mqttConn.on('timeout', function () {
    mqttConn.end(data)
  })
}

function startAedes () {
  const broker = aedes({
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

  const server = require('net').createServer(broker.handle)

  server.listen(brokerPort, function () {
    console.log('Aedes listening on :', server.address())
    broker.publish({ topic: 'aedes/hello', payload: "I'm broker " + broker.id })
    setTimeout(() => sendProxyPacket(1), 250)
    setTimeout(() => sendProxyPacket(1, 6), 500)
    setTimeout(() => sendProxyPacket(2), 750)
    setTimeout(() => sendProxyPacket(2, 6), 1000)
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
