'use strict'

var retimer = require('retimer')
var pump = require('pump')
var write = require('../write')
var QoSPacket = require('../qos-packet')
var through = require('through2')
var handleSubscribe = require('./subscribe')
var uuid = require('uuid')

function ClientPacketStatus (client, packet) {
  this.client = client
  this.packet = packet
}

var connectActions = [
  authenticate,
  registerClient,
  fetchSubs,
  restoreSubs,
  storeWill,
  doConnack,
  emptyQueue
]

function handleConnect (client, packet, done) {
  client.connected = true
  client.clean = packet.clean

  if (!packet.clientId && packet.protocolVersion === 3) {
    client.emit('error', new Error('Empty clientIds are supported only on MQTT 3.1.1'))
    return done()
  }

  client.id = packet.clientId || uuid.v4()
  client.will = packet.will

  //client.broker.registerClient(client)

  clearTimeout(client._connectTimer)
  client._connectTimer = null

  if (packet.keepalive > 0) {
    client._keepaliveInterval = packet.keepalive * 1501
    client._keepaliveTimer = retimer(function keepaliveTimeout () {
      client.emit('error', new Error('keep alive timeout'))
    }, client._keepaliveInterval)
  }

  client.broker._series(
    new ClientPacketStatus(client, packet),
    connectActions, {}, done)
}

function authenticate (arg, done) {
  var client = this.client
  client.broker.authenticate(
    client,
    this.packet.username,
    this.packet.password,
    negate)

  function negate (err, successful) {
    if (!err && successful) {
      return done()
    } else if (err) {
      write(client, {
        cmd: 'connack',
        returnCode: 4
      }, client.close.bind(client, done))
    } else {
      write(client, {
        cmd: 'connack',
        returnCode: 5
      }, client.close.bind(client, done))
    }
  }
}

function registerClient (arg, done) {
  this.client.broker.registerClient(this.client)
}

function fetchSubs (arg, done) {
  if (!this.packet.clean) {
    this.client.broker.persistence.subscriptionsByClient({
      id: this.client.id,
      done: done,
      arg: arg
    }, gotSubs)
  } else {
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
    handleSubscribe(this.client, { subscriptions: arg.subs }, done)
  } else {
    done()
  }
}

function storeWill (arg, done) {
  if (this.client.will) {
    this.client.broker.persistence.putWill(
      this.client,
      this.client.will,
      done)
  } else {
    done()
  }
}

function Connack (arg) {
  this.cmd = 'connack'
  this.returnCode = 0
  this.sessionPresent = !!arg.subs // cast to boolean
}

function doConnack (arg, done) {
  write(this.client, new Connack(arg), done)
}

function emptyQueue (arg, done) {
  var client = this.client
  var persistence = client.broker.persistence
  var outgoing = persistence.outgoingStream(client)

  pump(outgoing, through.obj(function (data, enc, next) {
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

  if (client.clean) {
    persistence.outgoingClearMessageId(client, packet, next)
  } else {
    write(client, packet, next)
  }
}

module.exports = handleConnect
