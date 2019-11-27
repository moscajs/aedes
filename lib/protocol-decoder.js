'use strict'

var proxyProtocol = require('proxy-protocol-js')

function protocolDecoder (client, data) {
  var proto = {}
  // var buffer = Buffer.allocUnsafe(0)
  // buffer = client.conn.read(null)
  if (!data) return proto
  // todo: checkProxiesList(client.conn, client.broker.trustedProxies)
  var trustProxy = client.broker.trustProxy
  var ipFamily
  var conn = client.conn
  var socket = conn.socket || conn
  var headers = client.req && client.req.headers ? client.req.headers : null
  if (trustProxy && headers) {
    if (headers['x-real-ip']) proto.ipAddress = headers['x-real-ip']
    else if (headers['x-forwarded-for']) proto.ipAddress = headers['x-forwarded-for']
    client.connDetails.isWebsocket = true
    client.connDetails.isProxied = true
  } else if (trustProxy) {
    var proxyProto
    try {
      proxyProto = proxyProtocol.V1BinaryProxyProtocol.parse(data)
    } catch (V1BinaryProxyProtocolE) {
      try {
        proxyProto = proxyProtocol.V2ProxyProtocol.parse(data)
      } catch (V2ProxyProtocolE) {
        // empty;
      }
    } finally {
      if (proxyProto && proxyProto.source && proxyProto.data) {
        ipFamily = proxyProto.inetProtocol
        proto.ipAddress = proxyProto.source.ipAddress
        proto.data = proxyProto.data
        client.connDetails.isWebsocket = false
        client.connDetails.isProxied = true
      } else if (proxyProto && proxyProto.proxyAddress && proxyProto.data) {
        if (proxyProto.proxyAddress instanceof proxyProtocol.IPv4ProxyAddress) {
          ipFamily = 'IPv4'
        } else if (proxyProto.proxyAddress instanceof proxyProtocol.IPv6ProxyAddress) {
          ipFamily = 'IPv6'
        }
        proto.ipAddress = proxyProto.proxyAddress.sourceAddress.address.join('.')
        if (Buffer.isBuffer(proxyProto.data)) {
          proto.data = proxyProto.data
        } else {
          proto.data = Buffer.from(proxyProto.data)
        }
        client.connDetails.isWebsocket = false
        client.connDetails.isProxied = true
      }
    }
  }
  if (!proto.ipAddress) {
    if (socket._socket && socket._socket.address) {
      client.connDetails.isWebsocket = true
      client.connDetails.isProxied = false
      proto.ipAddress = socket._socket.remoteAddress
      ipFamily = socket._socket.remoteFamily
    } else if (socket.address) {
      proto.ipAddress = socket.remoteAddress
      ipFamily = socket.remoteFamily
      client.connDetails.isWebsocket = false
      client.connDetails.isProxied = false
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
  if (proto.ipFamily !== undefined) {
    client.connDetails.ipFamily = proto.ipFamily
  }
  return proto
}

module.exports = protocolDecoder
