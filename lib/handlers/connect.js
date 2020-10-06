'use strict'

const retimer = require('retimer')
const { pipeline } = require('readable-stream')
const write = require('../write')
const QoSPacket = require('../qos-packet')
const { through } = require('../utils')
const handleSubscribe = require('./subscribe')
const shortid = require('shortid')

function Connack (arg) {
  this.cmd = 'connack'
  this.returnCode = arg.returnCode
  this.sessionPresent = arg.sessionPresent
}

function ClientPacketStatus (client, packet) {
  this.client = client
  this.packet = packet
}

const connectActions = [
  authenticate,
  setKeepAlive,
  fetchSubs,
  restoreSubs,
  storeWill,
  registerClient,
  doConnack,
  emptyQueue
]

const errorMessages = [
  '',
  'unacceptable protocol version',
  'identifier rejected',
  'Server unavailable',
  'bad user name or password',
  'not authorized'
]

function handleConnect (client, packet, done) {
  clearTimeout(client._connectTimer)
  client._connectTimer = null
  client.connecting = true
  client.broker.preConnect(client, packet, negate)

  function negate (err, successful) {
    if (!err && successful === true) {
      setImmediate(init, client, packet, done)
    } else {
      client.connecting = false
      done(err)
    }
  }
}

function init (client, packet, done) {
  const clientId = packet.clientId
  var returnCode = 0
  // [MQTT-3.1.2-2]
  if (packet.protocolVersion < 3 || packet.protocolVersion > 4) {
    returnCode = 1
  }
  // MQTT 3.1.0 allows <= 23 client id length
  if (packet.protocolVersion === 3 && clientId.length > client.broker.maxClientsIdLength) {
    returnCode = 2
  }
  if (returnCode > 0) {
    var error = new Error(errorMessages[returnCode])
    error.errorCode = returnCode
    doConnack(
      { client: client, returnCode: returnCode, sessionPresent: false },
      done.bind(this, error))
    return
  }

  client.id = clientId || 'aedes_' + shortid()
  client.clean = packet.clean
  client.version = packet.protocolVersion
  client._will = packet.will

  client.broker._series(
    new ClientPacketStatus(client, packet),
    connectActions,
    { returnCode: 0, sessionPresent: false }, // [MQTT-3.1.4-4], [MQTT-3.2.2-4]
    function (err) {
      this.client.connecting = false
      if (!err) {
        this.client.connected = true
        this.client.broker.emit('clientReady', client)
        this.client.emit('connected')
      }
      done(err)
    })
}

function authenticate (arg, done) {
  const client = this.client
  client.pause()
  client.broker.authenticate(
    client,
    this.packet.username,
    this.packet.password,
    negate)

  function negate (err, successful) {
    if (client.closed || client.broker.closed) {
      // a hack, sometimes client.close() or broker.close() happened
      // before authenticate() comes back
      // we stop here for not to register it and deregister it in write()
      return
    }
    if (!err && successful) {
      client._authorized = true
      return done()
    }

    if (err) {
      const errCode = err.returnCode
      if (errCode && (errCode >= 2 && errCode <= 5)) {
        arg.returnCode = errCode
      } else {
        arg.returnCode = 5
      }
      if (!err.message) {
        err.message = errorMessages[arg.returnCode]
      }
    } else {
      arg.returnCode = 5
      err = new Error(errorMessages[arg.returnCode])
    }
    err.errorCode = arg.returnCode
    arg.client = client
    doConnack(arg,
      // [MQTT-3.2.2-5]
      client.close.bind(client, done.bind(this, err)))
  }
}

function setKeepAlive (arg, done) {
  if (this.packet.keepalive > 0) {
    const client = this.client
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
  const client = this.client
  if (!this.packet.clean) {
    client.broker.persistence.subscriptionsByClient({
      id: client.id,
      done: done,
      arg: arg
    }, gotSubs)
    return
  }
  arg.sessionPresent = false // [MQTT-3.2.2-1]
  client.broker.persistence.cleanSubscriptions(
    client,
    done)
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
    handleSubscribe(this.client, { subscriptions: arg.subs }, true, done)
    arg.sessionPresent = !!arg.subs // cast to boolean, [MQTT-3.2.2-2]
    return
  }
  arg.sessionPresent = false // [MQTT-3.2.2-1], [MQTT-3.2.2-3]
  done()
}

function storeWill (arg, done) {
  const client = this.client
  client.will = client._will
  // delete any existing will messages from persistence
  client.broker.persistence.delWill(client, function () {
    if (client.will) {
      client.broker.persistence.putWill(
        client,
        client.will,
        done)
    } else {
      done()
    }
  })
}

function registerClient (arg, done) {
  const client = this.client
  client.broker.registerClient(client)
  done()
}

function doConnack (arg, done) {
  const client = arg.client || this.client
  const connack = new Connack(arg)
  write(client, connack, function (err) {
    if (!err) {
      client.broker.emit('connackSent', connack, client)
      client.connackSent = true
    }
    done(err)
  })
}

// push any queued messages (included retained messages) at the disconnected time
// when QoS > 0 and session is true
function emptyQueue (arg, done) {
  const client = this.client
  const persistence = client.broker.persistence
  const outgoing = persistence.outgoingStream(client)

  client.resume()

  pipeline(
    outgoing,
    through(function clearQueue (data, enc, next) {
      var packet = new QoSPacket(data, client)
      packet.writeCallback = next
      persistence.outgoingUpdate(client, packet, emptyQueueFilter)
    }),
    done
  )
}

function emptyQueueFilter (err, client, packet) {
  const next = packet.writeCallback

  if (err) {
    client.emit('error', err)
    return next()
  }

  const authorized = (packet.cmd === 'publish')
    ? client.broker.authorizeForward(client, packet)
    : true

  const persistence = client.broker.persistence

  if (client.clean || !authorized) {
    persistence.outgoingClearMessageId(client, packet, next)
  } else {
    write(client, packet, next)
  }
}

module.exports = handleConnect
