'use strict'

const mqtt = require('mqtt-packet')
const EE = require('events').EventEmitter
const util = require('util')
const eos = require('end-of-stream')
const empty = Buffer.allocUnsafe(0)
const Packet = require('aedes-packet')
const write = require('./write')
const QoSPacket = require('./qos-packet')
const handleSubscribe = require('./handlers/subscribe')
const handleUnsubscribe = require('./handlers/unsubscribe')
const handle = require('./handlers')

module.exports = Client

function Client (broker, conn, req) {
  const that = this

  // metadata
  this.connected = false
  this.connackSent = false
  this.errored = false

  // mqtt params
  this.id = null
  this.clean = true

  this.subscriptions = {}
  this.duplicates = {}

  this.broker = broker
  this.conn = conn
  conn.client = this

  this._disconnected = false
  this._authorized = false
  this._parsingBatch = 1
  this._nextId = Math.ceil(Math.random() * 65535)

  this.req = req
  this.connDetails = null

  // we use two variables for the will
  // because we store in _will while
  // we are authenticating
  this.will = null
  this._will = null

  this._parser = mqtt.parser()
  this._parser.client = this
  this._parser._queue = [] // queue packets received before client fires 'connect' event. Prevents memory leaks on 'connect' event
  this._parser.on('packet', enqueue)
  this.once('connected', dequeue)

  function nextBatch (err) {
    if (err) {
      that.emit('error', err)
      return
    }

    const client = that

    if (client._paused) {
      return
    }

    that._parsingBatch--
    if (that._parsingBatch <= 0) {
      that._parsingBatch = 0
      var buf = empty
      buf = client.conn.read(null)
      if (!client.connackSent && client.broker.decodeProtocol && client.broker.trustProxy && buf) {
        const { data } = client.broker.decodeProtocol(client, buf)
        if (data) {
          client._parser.parse(data)
        } else {
          client._parser.parse(buf)
        }
      } else if (buf) {
        client._parser.parse(buf)
      }
    }
  }
  this._nextBatch = nextBatch

  conn.on('readable', nextBatch)

  this.on('error', onError)
  conn.on('error', this.emit.bind(this, 'error'))
  this._parser.on('error', this.emit.bind(this, 'error'))

  conn.on('end', this.close.bind(this))
  this._eos = eos(this.conn, this.close.bind(this))

  this.deliver0 = function deliverQoS0 (_packet, cb) {
    const toForward = dedupe(that, _packet) &&
      that.broker.authorizeForward(that, _packet)
    if (toForward) {
      // Give nodejs some time to clear stacks, or we will see
      // "Maximum call stack size exceeded" in a very high load
      setImmediate(() => {
        var packet = new Packet(toForward, broker)
        packet.qos = 0
        write(that, packet, cb)
      })
    } else {
      setImmediate(cb)
    }
  }

  this.deliverQoS = function deliverQoS (_packet, cb) {
    // downgrade to qos0 if requested by publish
    if (_packet.qos === 0) {
      that.deliver0(_packet, cb)
      return
    }
    const toForward = dedupe(that, _packet) &&
      that.broker.authorizeForward(that, _packet)
    if (toForward) {
      setImmediate(() => {
        var packet = new QoSPacket(toForward, that)
        // Downgrading to client subscription qos if needed
        const clientSub = that.subscriptions[packet.topic]
        if (clientSub && (clientSub.qos || 0) < packet.qos) {
          packet.qos = clientSub.qos
        }
        packet.writeCallback = cb
        if (that.clean || packet.retain) {
          writeQoS(null, that, packet)
        } else {
          broker.persistence.outgoingUpdate(that, packet, writeQoS)
        }
      })
    } else if (that.clean === false) {
      that.broker.persistence.outgoingClearMessageId(that, _packet, nop)
      // we consider this to be an error, since the packet is undefined
      // so there's nothing to send
      setImmediate(cb)
    } else {
      setImmediate(cb)
    }
  }

  this._keepaliveTimer = null
  this._keepaliveInterval = -1

  this._connectTimer = setTimeout(function () {
    that.emit('error', new Error('connect did not arrive in time'))
  }, broker.connectTimeout)
}

function dedupe (client, packet) {
  const id = packet.brokerId
  if (!id) {
    return true
  }
  var duplicates = client.duplicates
  const counter = packet.brokerCounter
  const result = (duplicates[id] || 0) < counter
  if (result) {
    duplicates[id] = counter
  }
  return result
}

function writeQoS (err, client, packet) {
  if (err) {
    // is this right, or we should ignore thins?
    client.emit('error', err)
  } else {
    write(client, packet, packet.writeCallback)
  }
}

function onError (err) {
  this.errored = true
  this.conn.removeAllListeners('error')
  this.conn.on('error', nop)
  this.broker.emit(this.id ? 'clientError' : 'connectionError', this, err)
  this.close()
}

util.inherits(Client, EE)

Client.prototype._onError = onError

Client.prototype.publish = function (message, done) {
  const packet = new Packet(message, this.broker)
  const that = this
  if (packet.qos === 0) {
    // skip offline and send it as it is
    this.deliver0(packet, done)
    return
  }
  if (!this.clean && this.id) {
    this.broker.persistence.outgoingEnqueue({
      clientId: this.id
    }, packet, function deliver (err) {
      if (err) {
        return done(err)
      }
      that.deliverQoS(packet, done)
    })
  } else {
    that.deliverQoS(packet, done)
  }
}

Client.prototype.subscribe = function (packet, done) {
  if (!packet.subscriptions) {
    if (!Array.isArray(packet)) {
      packet = [packet]
    }
    packet = {
      subscriptions: packet
    }
  }
  handleSubscribe(this, packet, done)
}

Client.prototype.unsubscribe = function (packet, done) {
  if (!packet.unsubscriptions) {
    if (!Array.isArray(packet)) {
      packet = [packet]
    }
    packet = {
      unsubscriptions: packet
    }
  }
  handleUnsubscribe(this, packet, done)
}

Client.prototype.close = function (done) {
  const that = this

  if (this._eos === nop) {
    if (typeof done === 'function') {
      done()
    }
    return
  }

  const conn = this.conn

  this._parser.removeAllListeners('packet')
  conn.removeAllListeners('readable')

  this._parser._queue = null

  if (this._keepaliveTimer) {
    this._keepaliveTimer.clear()
    this._keepaliveInterval = -1
    this._keepaliveTimer = null
  }

  if (this._connectTimer) {
    clearTimeout(this._connectTimer)
    this._connectTimer = null
  }

  this._eos()
  this._eos = nop

  if (this.connected) {
    handleUnsubscribe(
      this,
      {
        close: true,
        unsubscriptions: Object.keys(this.subscriptions)
      },
      finish)
  } else {
    finish()
  }

  function finish () {
    if (!that._disconnected && that.will) {
      const will = Object.assign({}, that.will)
      that.broker.authorizePublish(that, will, function (err) {
        if (!err) {
          that.broker.publish(will, that, done)
        } else {
          done()
        }

        function done (err) {
          if (!err) {
            that.broker.persistence.delWill({
              id: that.id,
              brokerId: that.broker.id
            }, nop)
          }
        }
      })
    }
    that.will = null // this function might be called twice
    that._will = null

    conn.removeAllListeners('error')
    conn.on('error', nop)

    that.connected = false

    if (that.broker.clients[that.id] && that._authorized) {
      that.broker.unregisterClient(that)
    }

    // clear up the drain event listeners
    that.conn.emit('drain')
    that.conn.removeAllListeners('drain')

    conn.destroy()

    if (typeof done === 'function') {
      done()
    }
  }
}

Client.prototype.pause = function () {
  this._paused = true
}

Client.prototype.resume = function () {
  this._paused = false
  this._nextBatch()
}

function enqueue (packet) {
  const client = this.client
  client._parsingBatch++
  // already connected or it's the first packet
  if (client.connackSent || client._parsingBatch === 1) {
    handle(client, packet, client._nextBatch)
  } else {
    if (this._queue.length < client.broker.queueLimit) {
      this._queue.push(packet)
    } else {
      this.emit('error', new Error('Client queue limit reached'))
    }
  }
}

function dequeue () {
  const q = this._parser._queue
  if (q) {
    for (var i = 0, len = q.length; i < len; i++) {
      handle(this, q[i], this._nextBatch)
    }

    this._parser._queue = null
  }
}

function nop () { }
