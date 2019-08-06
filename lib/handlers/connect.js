'use strict'

var retimer = require('retimer')
var pump = require('pump')
var write = require('../write')
var QoSPacket = require('../qos-packet')
var through = require('through2')
var handleSubscribe = require('./subscribe')
var shortid = require('shortid')

function Connack (arg) {
  this.cmd = 'connack'
  this.returnCode = arg.returnCode
  this.sessionPresent = arg.sessionPresent
}

function ClientPacketStatus (client, packet) {
  this.client = client
  this.packet = packet
}

var connectActions = [
  authenticate,
  setKeepAlive,
  fetchSubs,
  restoreSubs,
  storeWill,
  registerClient,
  doConnack,
  emptyQueue
]

var errorMessages = [
  '',
  'unacceptable protocol version',
  'identifier rejected',
  'Server unavailable',
  'bad user name or password',
  'not authorized'
]

function handleConnect (client, packet, done) {
  if (client.broker.preConnect(client) === false) {
    return client.conn.destroy()
  }
  client.connected = true
  var clientId = packet.clientId
  var returnCode = 0
  // [MQTT-3.1.2-2]
  if (packet.protocolVersion < 3 || packet.protocolVersion > 4) {
    returnCode = 1
  }
  // MQTT 3.1.0 allows <= 23 client id length
  if (packet.protocolVersion === 3 && clientId.length > 23) {
    returnCode = 2
  }
  // console.log(returnCode)
  if (returnCode > 0) {
    var error = new Error(errorMessages[returnCode])
    error.errorCode = returnCode
    client.broker.emit('clientError', client, error)
    doConnack(
      { client: client, returnCode: returnCode, sessionPresent: false },
      done.bind(this, error))
    return client.conn.end()
  }

  client.id = clientId || 'aedes_' + shortid()
  client.clean = packet.clean
  client._will = packet.will

  clearTimeout(client._connectTimer)
  client._connectTimer = null

  client.broker._series(
    new ClientPacketStatus(client, packet),
    connectActions,
    { returnCode: 0, sessionPresent: false }, // [MQTT-3.1.4-4], [MQTT-3.2.2-4]
    function (err) {
      this.client.broker.emit('clientReady', client)
      this.client.emit('connected')
      done(err)
    })
}

function authenticate (arg, done) {
  var client = this.client
  client.pause()
  client.broker.authenticate(
    client,
    this.packet.username,
    this.packet.password,
    negate)

  function negate (err, successful) {
    if (!client.connected) {
      // a hack, sometimes close() happened before authenticate() comes back
      // we stop here for not to register it and deregister it in write()
      return
    }
    if (!err && successful) {
      return done()
    }

    if (err) {
      var errCode = err.returnCode
      if (errCode && (errCode >= 1 && errCode <= 3)) {
        arg.returnCode = errCode
      } else {
        // If errorCode is 4 or not a number
        arg.returnCode = 4
      }
    } else {
      arg.returnCode = 5
    }
    var error = new Error(errorMessages[arg.returnCode])
    error.errorCode = arg.returnCode
    client.broker.emit('clientError', client, error)
    arg.client = client
    doConnack(arg,
      // [MQTT-3.2.2-5]
      client.close.bind(client, done.bind(this, error)))
  }
}

function setKeepAlive (arg, done) {
  if (this.packet.keepalive > 0) {
    var client = this.client
    // [MQTT-3.1.2-24]
    client._keepaliveInterval = (this.packet.keepalive * 1500) + 1
    client._keepaliveTimer = retimer(function keepaliveTimeout () {
      client.broker.emit('keepaliveTimeout', client)
      client.emit('error', new Error('keep alive timeout'))
    }, client._keepaliveInterval)
  }
  done()
}

function fetchSubs (arg, done) {
  if (!this.packet.clean) {
    this.client.broker.persistence.subscriptionsByClient({
      id: this.client.id,
      done: done,
      arg: arg
    }, gotSubs)
  } else {
    arg.sessionPresent = false // [MQTT-3.2.2-1]
    this.client.broker.persistence.cleanSubscriptions(
      this.client,
      done)
  }
}

function gotSubs (err, subs, client) {
  if (err) {
    return client.done(err)
  }
  client.arg.subs = subs
  client.done()
}

function restoreSubs (arg, done) {
  if (arg.subs) {
    handleSubscribe(this.client, { subscriptions: arg.subs, restore: true }, done)
    arg.sessionPresent = !!arg.subs // cast to boolean, [MQTT-3.2.2-2]
  } else {
    arg.sessionPresent = false // [MQTT-3.2.2-1], [MQTT-3.2.2-3]
    done()
  }
}

function storeWill (arg, done) {
  this.client.will = this.client._will
  if (this.client.will) {
    this.client.broker.persistence.putWill(
      this.client,
      this.client.will,
      done)
  } else {
    done()
  }
}

function registerClient (arg, done) {
  var client = this.client
  client.broker.registerClient(client)
  done()
}

function doConnack (arg, done) {
  var client = arg.client || this.client
  const connack = new Connack(arg)
  write(client, connack, function () {
    client.broker.emit('connackSent', connack, client)
    client.connackSent = true
    done()
  })
}

function emptyQueue (arg, done) {
  var client = this.client
  var persistence = client.broker.persistence
  var outgoing = persistence.outgoingStream(client)

  client.resume()

  pump(outgoing, through.obj(function clearQueue (data, enc, next) {
    var packet = new QoSPacket(data, client)
    packet.writeCallback = next
    persistence.outgoingUpdate(client, packet, emptyQueueFilter)
  }), done)
}

function emptyQueueFilter (err, client, packet) {
  var next = packet.writeCallback
  var persistence = client.broker.persistence

  if (err) {
    client.emit('error', err)
    return next()
  }

  var authorized = true

  if (packet.cmd === 'publish') {
    authorized = client.broker.authorizeForward(client, packet)
  }

  if (client.clean || !authorized) {
    persistence.outgoingClearMessageId(client, packet, next)
  } else {
    write(client, packet, next)
  }
}

module.exports = handleConnect
