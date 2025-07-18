import EventEmitter from 'node:events'
import parallel from 'fastparallel'
import series from 'fastseries'
import { v4 as uuidv4 } from 'uuid'
import reusify from 'reusify'
import { pipeline } from 'stream'
import Packet from 'aedes-packet'
import memory from 'aedes-persistence'
import mqemitter from 'mqemitter'
import Client from './lib/client.js'
import { $SYS_PREFIX, bulk } from './lib/utils.js'
import pkg from './package.json' with { type: 'json' }

const defaultOptions = {
  concurrency: 100,
  heartbeatInterval: 60000, // 1 minute
  connectTimeout: 30000, // 30 secs
  decodeProtocol: null,
  preConnect: defaultPreConnect,
  authenticate: defaultAuthenticate,
  authorizePublish: defaultAuthorizePublish,
  authorizeSubscribe: defaultAuthorizeSubscribe,
  authorizeForward: defaultAuthorizeForward,
  published: defaultPublished,
  trustProxy: false,
  trustedProxies: [],
  queueLimit: 42,
  maxClientsIdLength: 23,
  keepaliveLimit: 0
}
const version = pkg.version

export class Aedes extends EventEmitter {
  constructor (opts) {
    super()
    const that = this

    opts = Object.assign({}, defaultOptions, opts)
    this.opts = opts
    this.id = opts.id || uuidv4()
    // +1 when construct a new aedes-packet
    // internal track for last brokerCounter
    this.counter = 0
    this.queueLimit = opts.queueLimit
    this.connectTimeout = opts.connectTimeout
    this.keepaliveLimit = opts.keepaliveLimit
    this.maxClientsIdLength = opts.maxClientsIdLength
    this.mq = opts.mq || mqemitter({
      concurrency: opts.concurrency,
      matchEmptyLevels: true // [MQTT-4.7.1-3]
    })
    this.handle = function handle (conn, req) {
      conn.setMaxListeners(opts.concurrency * 2)
      // create a new Client instance for a new connection
      // return, just to please standard
      return new Client(that, conn, req)
    }

    this._parallel = parallel()
    this._series = series()
    this._enqueuers = reusify(DoEnqueues)

    this.preConnect = opts.preConnect
    this.authenticate = opts.authenticate
    this.authorizePublish = opts.authorizePublish
    this.authorizeSubscribe = opts.authorizeSubscribe
    this.authorizeForward = opts.authorizeForward
    this.published = opts.published

    this.decodeProtocol = opts.decodeProtocol
    this.trustProxy = opts.trustProxy
    this.trustedProxies = opts.trustedProxies

    this.clients = {}
    this.brokers = {}
    this.closed = true
  }

  async listen () {
    const opts = this.opts
    const that = this

    // metadata
    this.connectedClients = 0
    this.closed = false

    this.persistence = opts.persistence || memory()
    if (this.persistence.setup.constructor.name !== 'AsyncFunction') {
      throw new Error('persistence.setup() must be an async function')
    }
    await this.persistence.setup(this)

    const heartbeatTopic = $SYS_PREFIX + that.id + '/heartbeat'
    const birthTopic = $SYS_PREFIX + that.id + '/birth'

    this._heartbeatInterval = setInterval(heartbeat, opts.heartbeatInterval)

    const bufId = Buffer.from(that.id, 'utf8')

    // in a cluster env this is used to warn other broker instances
    // that this broker is alive
    that.publish({
      topic: birthTopic,
      payload: bufId
    }, noop)

    function heartbeat () {
      that.publish({
        topic: heartbeatTopic,
        payload: bufId
      }, noop)
    }

    function deleteOldBrokers (broker) {
      if (that.brokers[broker] + (3 * opts.heartbeatInterval) < Date.now()) {
        delete that.brokers[broker]
      }
    }

    this._clearWillInterval = setInterval(function () {
      Object.keys(that.brokers).forEach(deleteOldBrokers)

      pipeline(
        that.persistence.streamWill(that.brokers),
        bulk(receiveWills),
        function done (err) {
          if (err) {
            that.emit('error', err)
          }
        }
      )
    }, opts.heartbeatInterval * 4)

    function receiveWills (chunks, done) {
      that._parallel(that, checkAndPublish, chunks, done)
    }

    function checkAndPublish (will, done) {
      const notPublish = that.brokers[will.brokerId] !== undefined && that.brokers[will.brokerId] + (3 * opts.heartbeatInterval) >= Date.now()

      if (notPublish) return done()

      // randomize this, so that multiple brokers
      // do not publish the same wills at the same time
      this.authorizePublish(that.clients[will.clientId] || null, will, function (err) {
        if (err) { return doneWill() }
        that.publish(will, doneWill)

        function doneWill (err) {
          if (err) { return done(err) }
          that.persistence.delWill({
            id: will.clientId,
            brokerId: will.brokerId
          }).then(will => done(undefined, will), done)
        }
      })
    }

    this.mq.on($SYS_PREFIX + '+/heartbeat', function storeBroker (packet, done) {
      that.brokers[packet.payload.toString()] = Date.now()
      done()
    })

    this.mq.on($SYS_PREFIX + '+/birth', function brokerBorn (packet, done) {
      const brokerId = packet.payload.toString()

      // reset duplicates counter
      if (brokerId !== that.id) {
        for (const clientId in that.clients) {
          delete that.clients[clientId].duplicates[brokerId]
        }
      }

      done()
    })

    this.mq.on($SYS_PREFIX + '+/new/clients', function closeSameClients (packet, done) {
      const serverId = packet.topic.split('/')[1]
      const clientId = packet.payload.toString()

      if (that.clients[clientId] && serverId !== that.id) {
        if (that.clients[clientId].closed) {
          // remove the client from the list if it is already closed
          that.deleteClient(clientId)
          done()
        } else {
          that.clients[clientId].close(done)
        }
      } else {
        done()
      }
    })
  }

  get version () {
    return version
  }

  static async createBroker (opts) {
    const aedes = new Aedes(opts)
    await aedes.listen()
    return aedes
  }

  publish (packet, client, done) {
    if (typeof client === 'function') {
      done = client
      client = null
    }
    const p = new Packet(packet, this)
    const publishFuncs = p.qos > 0 ? publishFuncsQoS : publishFuncsSimple

    this._series(new PublishState(this, client, packet), publishFuncs, p, done)
  }

  subscribe (topic, func, done) {
    this.mq.on(topic, func, done)
  }

  unsubscribe (topic, func, done) {
    this.mq.removeListener(topic, func, done)
  }

  registerClient (client) {
    const that = this
    if (this.clients[client.id]) {
      // [MQTT-3.1.4-2]
      this.clients[client.id].close(function closeClient () {
        that._finishRegisterClient(client)
      })
    } else {
      this._finishRegisterClient(client)
    }
  }

  _finishRegisterClient (client) {
    this.connectedClients++
    this.clients[client.id] = client
    this.emit('client', client)
    this.publish({
      topic: $SYS_PREFIX + this.id + '/new/clients',
      payload: Buffer.from(client.id, 'utf8')
    }, noop)
  }

  unregisterClient (client) {
    this.deleteClient(client.id)
    this.emit('clientDisconnect', client)
    this.publish({
      topic: $SYS_PREFIX + this.id + '/disconnect/clients',
      payload: Buffer.from(client.id, 'utf8')
    }, noop)
  }

  deleteClient (clientId) {
    this.connectedClients--
    delete this.clients[clientId]
  }

  close (cb = noop) {
    const that = this
    if (this.closed) {
      return cb()
    }
    this.closed = true
    clearInterval(this._heartbeatInterval)
    clearInterval(this._clearWillInterval)
    this._parallel(this, closeClient, Object.keys(this.clients), doneClose)
    function doneClose () {
      that.emit('closed')
      that.mq.close(cb)
    }
  }
}

function storeRetained (packet, done) {
  if (packet.retain) {
    this.broker.persistence.storeRetained(packet)
      .then(() => done(null), done)
  } else {
    done()
  }
}

function emitPacket (packet, done) {
  if (this.client) packet.clientId = this.client.id
  this.broker.mq.emit(packet, done)
}

function enqueueOffline (packet, done) {
  const enqueuer = this.broker._enqueuers.get()

  enqueuer.complete = done
  enqueuer.packet = packet
  enqueuer.topic = packet.topic
  enqueuer.broker = this.broker
  this.broker.persistence.subscriptionsByTopic(packet.topic)
    .then(subs => enqueuer.done(null, subs), enqueuer.done)
}

class DoEnqueues {
  constructor () {
    this.next = null
    this.complete = null
    this.packet = null
    this.topic = null
    this.broker = null

    const that = this

    this.done = function doneEnqueue (err, subs) {
      const broker = that.broker

      if (err) {
        // is this really recoverable?
        // let's just error the whole aedes
        // https://nodejs.org/api/events.html#events_error_events
        broker.emit('error', err)
        return
      }

      if (that.topic.indexOf($SYS_PREFIX) === 0) {
        subs = subs.filter(removeSharp)
      }

      const packet = that.packet
      const complete = that.complete

      that.packet = null
      that.complete = null
      that.topic = null

      broker.persistence.outgoingEnqueueCombi(subs, packet)
        .then(() => complete(null), complete)
      broker._enqueuers.release(that)
    }
  }
}

// + is 43
// # is 35
function removeSharp (sub) {
  const code = sub.topic.charCodeAt(0)
  return code !== 43 && code !== 35
}

function callPublished (_, done) {
  this.broker.published(this.packet, this.client, done)
  this.broker.emit('publish', this.packet, this.client)
}

const publishFuncsSimple = [
  storeRetained,
  emitPacket,
  callPublished
]
const publishFuncsQoS = [
  storeRetained,
  enqueueOffline,
  emitPacket,
  callPublished
]

function closeClient (client, cb) {
  this.clients[client].close(cb)
}

function defaultPreConnect (client, packet, callback) {
  callback(null, true)
}

function defaultAuthenticate (client, username, password, callback) {
  callback(null, true)
}

function defaultAuthorizePublish (client, packet, callback) {
  if (packet.topic.startsWith($SYS_PREFIX)) {
    return callback(new Error($SYS_PREFIX + ' topic is reserved'))
  }
  callback(null)
}

function defaultAuthorizeSubscribe (client, sub, callback) {
  callback(null, sub)
}

function defaultAuthorizeForward (client, packet) {
  return packet
}

function defaultPublished (packet, client, callback) {
  callback(null)
}

class PublishState {
  constructor (broker, client, packet) {
    this.broker = broker
    this.client = client
    this.packet = packet
  }
}

function noop () {}

function warnMigrate () {
  throw new Error(
` Aedes default export has been removed.
 Use 'const aedes = await Aedes.createBroker()' instead.
 See: https://github.com/moscajs/aedes/docs/MIGRATION.MD
 `)
}

export default warnMigrate
