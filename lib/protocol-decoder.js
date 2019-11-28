'use strict'

var proxyProtocol = require('proxy-protocol-js')

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

function protocolDecoder (client, data) {
  var proto = {}
  if (!data) return proto
  // todo: checkProxiesList(client.conn, client.broker.trustedProxies)
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
      if (headers['x-real-ip']) proto.ipAddress = headers['x-real-ip']
      else if (headers['x-forwarded-for']) proto.ipAddress = headers['x-forwarded-for']
      proto.isWebsocket = true
    }
    if (isValidV1ProxyProtocol(data)) {
      proxyProto = proxyProtocol.V1BinaryProxyProtocol.parse(data)
      if (proxyProto && proxyProto.source && proxyProto.data) {
        ipFamily = proxyProto.inetProtocol
        proto.ipAddress = proxyProto.source.ipAddress
        proto.data = proxyProto.data
        proto.isProxy = 1
      }
    } else if (isValidV2ProxyProtocol(data)) {
      proxyProto = proxyProtocol.V2ProxyProtocol.parse(data)
      if (proxyProto && proxyProto.proxyAddress && proxyProto.data) {
        if (proxyProto.proxyAddress instanceof proxyProtocol.IPv4ProxyAddress) {
          ipFamily = 'IPv4'
        } else if (proxyProto.proxyAddress instanceof proxyProtocol.IPv6ProxyAddress) {
          ipFamily = 'IPv6'
        }
        proto.ipAddress = proxyProto.proxyAddress.sourceAddress.address.join('.')
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
      ipFamily = socket._socket.remoteFamily
    } else if (socket.address) {
      proto.ipAddress = socket.remoteAddress
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
  if (proto.ipAddress) {
    client.connDetails.ipAddress = proto.ipAddress
  }
  client.connDetails.ipFamily = proto.ipFamily
  client.connDetails.isProxy = proto.isProxy
  return proto
}

module.exports = protocolDecoder
