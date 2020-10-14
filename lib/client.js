'use strict'

const EventEmitter = require('events')
const util = require('util')
const Packet = require('aedes-packet')
const write = require('./write')
const QoSPacket = require('./qos-packet')
const handleSubscribe = require('./handlers/subscribe')
const handleUnsubscribe = require('./handlers/unsubscribe')
const handle = require('./handlers')
const { Writable, finished, pipeline } = require('readable-stream')
const { through } = require('./utils')
const MqttStreamParser = require('./mqtt-stream-parser')

module.exports = Client

function Client (broker, conn, req) {
  const that = this

  // metadata
  this.closed = false
  this.connecting = false
  this.connected = false
  this.connackSent = false
  this.errored = false

  // mqtt params
  this.id = null
  this.clean = true
  this.version = null

  this.subscriptions = {}
  this.duplicates = {}

  this.broker = broker
  this.conn = conn
  conn.client = this

  this._disconnected = false
  this._authorized = false
  // for QoS > 0
  this._nextId = Math.ceil(Math.random() * 65535)

  this.req = req
  this.connDetails = null

  // we use two variables for the will
  // because we store in _will while
  // we are authenticating
  this.will = null
  this._will = null

  const mqttStream = new Writable({
    objectMode: true,
    emitClose: false,
    encoding: 'utf8',
    write: handlePacket
  })

  function handlePacket (packet, enc, done) {
    handle(that, packet, done)
  }

  const emitError = this.emit.bind(this, 'error')

  mqttStream.on('error', emitError)

  this._mqttStream = mqttStream
  this._mqttParserStream = new MqttStreamParser(this)

  conn.pipe(this._mqttParserStream).pipe(mqttStream)

  this.on('error', onError)
  conn.on('error', emitError)

  conn.on('end', this.close.bind(this))
  this._eos = finished(this.conn, this.close.bind(this))

  this.deliver0 = function deliverQoS0 (_packet, cb) {
    const toForward = dedupe(that, _packet) &&
      that.broker.authorizeForward(that, _packet)
    if (toForward) {
      // Give nodejs some time to clear stacks, or we will see
      // "Maximum call stack size exceeded" in a very high load
      setImmediate(() => {
        var packet = new Packet(toForward, broker)
        packet.qos = 0
        write(that, packet, function (err) {
          that._onError(err)
          cb() // don't pass the error here or it will be thrown by mqemitter
        })
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
      that.broker.persistence.outgoingClearMessageId(that, _packet, noop)
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
    // don't pass the error here or it will be thrown by mqemitter
    packet.writeCallback()
  } else {
    write(client, packet, function (err) {
      if (err) {
        client.emit('error', err)
      }
      // don't pass the error here or it will be thrown by mqemitter
      packet.writeCallback()
    })
  }
}

function drainRequest (req) {
  req.callback()
}

function onError (err) {
  if (!err) return

  this.errored = true
  this.conn.removeAllListeners('error')
  this.conn.on('error', noop)
  // hack to clean up the write callbacks in case of error
  var state = this.conn._writableState
  var list = typeof state.getBuffer === 'function' ? state.getBuffer() : state.buffer
  list.forEach(drainRequest)
  this.broker.emit(this.id ? 'clientError' : 'connectionError', this, err)
  this.close()
}

util.inherits(Client, EventEmitter)

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
  handleSubscribe(this, packet, false, done)
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
  if (this.closed) {
    if (typeof done === 'function') {
      done()
    }
    return
  }

  const that = this
  const conn = this.conn

  this.closed = true

  conn.unpipe(this._mqttParserStream)
  this._mqttParserStream.end()
  this._mqttStream.end()

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
  this._eos = noop

  handleUnsubscribe(
    this,
    {
      unsubscriptions: Object.keys(this.subscriptions)
    },
    finish)

  function finish () {
    // _disconnected is set only if client is disconnected with a valid disconnect packet
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
            }, noop)
          }
        }
      })
    }
    that.will = null // this function might be called twice
    that._will = null

    that.connected = false
    that.connecting = false

    conn.removeAllListeners('error')
    conn.on('error', noop)

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
  this.conn.pause()
}

Client.prototype.resume = function () {
  this.conn.resume()
}

Client.prototype.emptyOutgoingQueue = function (done) {
  const client = this
  const persistence = client.broker.persistence

  function filter (packet, enc, next) {
    persistence.outgoingClearMessageId(client, packet, next)
  }

  pipeline(
    persistence.outgoingStream(client),
    through(filter),
    done
  )
}

function noop () {}
