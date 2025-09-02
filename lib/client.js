import mqtt from 'mqtt-packet'
import EventEmitter from 'node:events'
import util from 'util'
import Packet from 'aedes-packet'
import write from './write.js'
import QoSPacket from './qos-packet.js'
import handleSubscribe from './handlers/subscribe.js'
import handleUnsubscribe from './handlers/unsubscribe.js'
import handle from './handlers/index.js'
import { pipeline, finished } from 'stream'
import { through } from './utils.js'

class Client {
  constructor (broker, conn, req) {
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
    this._parsingBatch = 1
    this._nextId = Math.ceil(Math.random() * 65535)

    this.req = req
    this.connDetails = req ? req.connDetails : null

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
        const buf = client.conn.read(null)
        if (buf) {
          client._parser.parse(buf)
        }
      }
    }
    this._nextBatch = nextBatch

    conn.on('readable', nextBatch)

    this.on('error', this._onError)
    conn.on('error', this.emit.bind(this, 'error'))
    this._parser.on('error', this.emit.bind(this, 'error'))

    conn.on('end', this.close.bind(this))
    this._eos = finished(this.conn, this.close.bind(this))

    const getToForwardPacket = (_packet) => {
      // Mqttv5 3.8.3.1: https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html#_Toc3901169
      // prevent to forward messages sent by the same client when no-local flag is set
      if (_packet.clientId === that.id && _packet.nl) return

      const toForward = dedupe(that, _packet) &&
        that.broker.authorizeForward(that, _packet)

      return toForward
    }

    this.deliver0 = function deliverQoS0 (_packet, cb) {
      const toForward = getToForwardPacket(_packet)

      if (toForward) {
        // Give nodejs some time to clear stacks, or we will see
        // "Maximum call stack size exceeded" in a very high load
        setImmediate(() => {
          const packet = new Packet(toForward, broker)
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
      const toForward = getToForwardPacket(_packet)

      if (toForward) {
        setImmediate(() => {
          const packet = new QoSPacket(toForward, that)
          // Downgrading to client subscription qos if needed
          const clientSub = that.subscriptions[packet.topic]
          if (clientSub && (clientSub.qos || 0) < packet.qos) {
            packet.qos = clientSub.qos
          }
          packet.writeCallback = cb
          const doWriteQoS = (err = null) => writeQoS(err, that, packet)
          if (that.clean || packet.retain) {
            doWriteQoS()
          } else {
            broker.persistence.outgoingUpdate(that, packet)
              .then(doWriteQoS, doWriteQoS)
          }
        })
      } else if (that.clean === false) {
        that.broker.persistence.outgoingClearMessageId(that, _packet)
          .then(noop, noop)
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

  _onError (err) {
    if (!err) return

    this.errored = true
    this.conn.removeAllListeners('error')
    this.conn.on('error', noop)
    // hack to clean up the write callbacks in case of error
    const state = this.conn._writableState
    const list = typeof state.getBuffer === 'function' ? state.getBuffer() : state.buffer
    list.forEach(drainRequest)
    this.broker.emit(this.id ? 'clientError' : 'connectionError', this, err)
    this.close()
  }

  publish (message, done) {
    const packet = new Packet(message, this.broker)
    const that = this
    if (packet.qos === 0) {
      // skip offline and send it as it is
      this.deliver0(packet, done)
      return
    }

    if (!this.clean && this.id) {
      this.broker.persistence.outgoingEnqueue({ clientId: this.id }, packet)
        .then(() => that.deliverQoS(packet, done), done)
    } else {
      that.deliverQoS(packet, done)
    }
  }

  subscribe (packet, done) {
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

  unsubscribe (packet, done) {
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

  close (done) {
    if (this.closed) {
      if (typeof done === 'function') {
        done()
      }
      return
    }

    const that = this
    const conn = this.conn

    this.closed = true

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
    this._eos = noop

    handleUnsubscribe(
      this,
      {
        unsubscriptions: Object.keys(this.subscriptions)
      },
      finish)

    function finish () {
      const will = that.will
      // _disconnected is set only if client is disconnected with a valid disconnect packet
      if (!that._disconnected && will) {
        that.broker.authorizePublish(that, will, function (err) {
          if (err) { return done() }
          that.broker.publish(will, that, done)

          function done () {
            that.broker.persistence.delWill({
              id: that.id,
              brokerId: that.broker.id
            }).then(noop, noop)
          }
        })
      } else if (will) {
        // delete the persisted will even on clean disconnect https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html#_Toc385349232
        that.broker.persistence.delWill({
          id: that.id,
          brokerId: that.broker.id
        }).then(noop, noop)
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

  pause () {
    this._paused = true
  }

  resume () {
    this._paused = false
    this._nextBatch()
  }

  emptyOutgoingQueue (done) {
    const client = this
    const persistence = client.broker.persistence

    function filter (packet, enc, next) {
      persistence.outgoingClearMessageId(client, packet)
        .then(pkt => next(null, pkt), next)
    }

    pipeline(
      persistence.outgoingStream(client),
      through(filter),
      done
    )
  }
}

function dedupe (client, packet) {
  const id = packet.brokerId
  if (!id) {
    return true
  }
  const duplicates = client.duplicates
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

util.inherits(Client, EventEmitter)

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
    for (let i = 0, len = q.length; i < len; i++) {
      handle(this, q[i], this._nextBatch)
    }

    this._parser._queue = null
  }
}

function noop () {}

export default Client
