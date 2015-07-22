'use strict'

var mqtt = require('mqtt-packet')
var EE = require('events').EventEmitter
var util = require('util')
var eos = require('end-of-stream')
var empty = new Buffer(0)
var Packet = require('./packet')
var write = require('./write')
var QoSPacket = require('./qos-packet')
var handleUnsubscribe = require('./handlers/unsubscribe')
var handle = require('./handlers')

module.exports = Client

function Client (broker, conn) {
  var that = this

  this.broker = broker
  this.conn = conn
  this.parser = mqtt.parser()
  this.connected = false
  this.clean = true
  this._handling = 0
  this.subscriptions = {}
  this.id = null

  conn.client = this

  this.parser.client = this

  this._parsingBatch = 1
  this._nextId = Math.ceil(Math.random() * 65535)

  this.disconnected = false

  this.parser.on('packet', enqueue)

  function nextBatch (err) {
    if (err) {
      return that.emit('error', err)
    }

    var buf = empty
    var client = that

    that._parsingBatch--
    if (that._parsingBatch <= 0) {
      that._parsingBatch = 0
      buf = client.conn.read(null)

      if (buf) {
        client.parser.parse(buf)
      }
    }
  }
  this._nextBatch = nextBatch

  nextBatch()

  conn.on('readable', nextBatch)
  conn.on('error', this.emit.bind(this, 'error'))
  this.parser.on('error', this.emit.bind(this, 'error'))

  this.on('error', onError)

  this._eos = eos(this.conn, this.close.bind(this))

  this.deliver0 = function deliverQoS0 (_packet, cb) {
    var packet = new Packet(_packet, broker)
    packet.qos = 0
    write(that, packet, cb)
  }

  this.deliver1 = function deliverQoS1 (_packet, cb) {
    var packet = new QoSPacket(_packet, that)
    packet.writeCallback = cb
    broker.persistence.outgoingUpdate(that, packet, writeQoS)
  }

  this.deliver2 = function deliverQoS2 (_packet, cb) {
    var packet = new QoSPacket(_packet, that)
    packet.writeCallback = cb
    broker.persistence.outgoingUpdate(that, packet, writeQoS)
  }

  this._keepaliveTimer = null
}

function writeQoS (err, client, packet) {
  if (err) {
    // is this right, or we should ignore thins?
    client.emit('error', err)
  } else {
    write(client, packet, packet.writeCallback)
  }
}

function drainRequest (req) {
  req.callback()
}

function onError (err) {
  this.conn.removeAllListeners('error')
  this.conn.on('error', function () {})
  // hack to clean up the write callbacks in case of error
  // supports streams2 & streams3, so node 0.10, 0.11, and iojs
  var state = this.conn._writableState
  var list = state.getBuffer && state.getBuffer() || state.buffer
  list.forEach(drainRequest)
  this.broker.emit('clientError', this, err)
  this.close()
}

util.inherits(Client, EE)

Client.prototype._onError = onError

Client.prototype.close = function (done) {
  var that = this
  var conn = this.conn

  if (this.connected) {
    handleUnsubscribe(
      this,
      { unsubscriptions: Object.keys(this.subscriptions) },
      finish)
  } else {
    finish()
  }

  if (this._keepaliveTimer) {
    this._keepaliveTimer.clear()
  }

  this._eos()
  this._eos = nop

  function finish () {
    if (!that.disconnected && that.will) {
      that.broker.publish(that.will)
    }

    conn.removeAllListeners('error')
    conn.on('error', nop)

    that.broker.unregisterClient(that)

    if (conn.destroy) {
      conn.destroy()
    } else {
      conn.end()
    }

    if (typeof done === 'function') {
      done()
    }
  }
}

function enqueue (packet) {
  this.client._parsingBatch++
  handle(this.client, packet, this.client._nextBatch)
}

function nop () {}
