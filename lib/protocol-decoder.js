'use strict'

var proxyProtocol = require('proxy-protocol-js')
var forwarded = require('forwarded')

var v1ProxyProtocolSignature = Buffer.from('PROXY ', 'utf8')
var v2ProxyProtocolSignature = Buffer.from([
  0x0d,
  0x0a,
  0x0d,
  0x0a,
  0x00,
  0x0d,
  0x0a,
  0x51,
  0x55,
  0x49,
  0x54,
  0x0a
])

function isValidV1ProxyProtocol (buffer) {
  for (var i = 0; i < v1ProxyProtocolSignature.length; i++) {
    if (buffer[i] !== v1ProxyProtocolSignature[i]) {
      return false
    }
  }
  return true
}

function isValidV2ProxyProtocol (buffer) {
  for (var i = 0; i < v2ProxyProtocolSignature.length; i++) {
    if (buffer[i] !== v2ProxyProtocolSignature[i]) {
      return false
    }
  }
  return true
}

// from https://stackoverflow.com/questions/57077161/how-do-i-convert-hex-buffer-to-ipv6-in-javascript
function parseIpV6Array (ip) {
  var ipHex = Buffer.from(ip).toString('hex')
  return ipHex.match(/.{1,4}/g)
    .map((val) => val.replace(/^0+/, ''))
    .join(':')
    .replace(/0000:/g, ':')
    .replace(/:{2,}/g, '::')
}

function protocolDecoder (client, data) {
  var proto = {}
  if (!data) return proto
  var trustProxy = client.broker.trustProxy
  var ipFamily
  var conn = client.conn
  var socket = conn.socket || conn
  proto.isProxy = 0
  proto.isWebsocket = false
  if (trustProxy) {
    var headers = client.req && client.req.headers ? client.req.headers : null
    var proxyProto
    if (headers) {
      if (headers['x-forwarded-for']) {
        var addresses = forwarded(client.req)
        proto.ipAddress = headers['x-real-ip'] ? headers['x-real-ip'] : addresses[addresses.length - 1]
        proto.serverIpAddress = addresses[0]
      }
      if (headers['x-real-ip']) {
        proto.ipAddress = headers['x-real-ip']
      }
      proto.port = socket._socket.remotePort
      ipFamily = socket._socket.remoteFamily
      proto.isWebsocket = true
    }
    if (isValidV1ProxyProtocol(data)) {
      proxyProto = proxyProtocol.V1BinaryProxyProtocol.parse(data)
      if (proxyProto && proxyProto.source && proxyProto.data) {
        ipFamily = proxyProto.inetProtocol
        proto.ipAddress = proxyProto.source.ipAddress
        proto.port = proxyProto.source.port
        proto.serverIpAddress = proxyProto.destination.ipAddress
        proto.data = proxyProto.data
        proto.isProxy = 1
      }
    } else if (isValidV2ProxyProtocol(data)) {
      proxyProto = proxyProtocol.V2ProxyProtocol.parse(data)
      if (proxyProto && proxyProto.proxyAddress && proxyProto.data) {
        if (proxyProto.proxyAddress instanceof proxyProtocol.IPv4ProxyAddress) {
          proto.ipAddress = proxyProto.proxyAddress.sourceAddress.address.join('.')
          proto.port = proxyProto.proxyAddress.sourceAddress.address.port
          proto.serverIpAddress = proxyProto.proxyAddress.destinationAddress.address.join('.')
          ipFamily = 'IPv4'
        } else if (proxyProto.proxyAddress instanceof proxyProtocol.IPv6ProxyAddress) {
          proto.ipAddress = parseIpV6Array(proxyProto.proxyAddress.sourceAddress.address)
          proto.port = proxyProto.proxyAddress.sourceAddress.address.port
          proto.serverIpAddress = parseIpV6Array(proxyProto.proxyAddress.destinationAddress.address)
          ipFamily = 'IPv6'
        }
        proto.isProxy = 2
        if (Buffer.isBuffer(proxyProto.data)) {
          proto.data = proxyProto.data
        } else {
          proto.data = Buffer.from(proxyProto.data)
        }
      }
    }
  }
  if (!proto.ipAddress) {
    if (socket._socket && socket._socket.address) {
      proto.isWebsocket = true
      proto.ipAddress = socket._socket.remoteAddress
      proto.port = socket._socket.remotePort
      proto.serverIpAddress = socket._socket.address().address
      ipFamily = socket._socket.remoteFamily
    } else if (socket.address) {
      proto.ipAddress = socket.remoteAddress
      proto.port = socket.remotePort
      proto.serverIpAddress = socket.address().address
      ipFamily = socket.remoteFamily
    }
  }
  if (ipFamily && ipFamily.endsWith('4')) {
    proto.ipFamily = 4
  } else if (ipFamily && ipFamily.endsWith('6')) {
    proto.ipFamily = 6
  } else {
    proto.ipFamily = 0
  }
  if (!client.connDetails) client.connDetails = {}
  if (proto.ipAddress) {
    client.connDetails.ipAddress = proto.ipAddress
  }
  if (proto.port) {
    client.connDetails.port = proto.port
  }
  if (proto.serverIpAddress) {
    client.connDetails.serverIpAddress = proto.serverIpAddress
  }
  client.connDetails.ipFamily = proto.ipFamily
  client.connDetails.isProxy = proto.isProxy
  client.connDetails.isWebsocket = proto.isWebsocket
  return proto
}

module.exports = protocolDecoder
