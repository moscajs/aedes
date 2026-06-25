import EventEmitter from 'node:events'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import Packet from 'aedes-packet'
import memory from 'aedes-persistence'
import mqemitter from 'mqemitter'
import Client from './lib/client.js'
import { $SYS_PREFIX, batch, noop, runSeries } from './lib/utils.js'
import { SESSION_NEVER_EXPIRES, ReasonCodes } from './lib/constants.js'
import pkg from './package.json' with { type: 'json' }

const defaultOptions = {
  concurrency: 100,
  heartbeatInterval: 60000, // 1 minute
  connectTimeout: 30000, // 30 secs
  drainTimeout: 60000, // 60 secs - protects against slow/frozen clients by default, set to 0 to disable
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
  keepaliveLimit: 0,
  // MQTT 5.0: maximum Topic Alias value the broker accepts from a client.
  // 0 disables inbound topic aliases (the value advertised in CONNACK).
  topicAliasMaximum: 0,
  // MQTT 5.0: maximum size (bytes) of a packet the broker accepts. 0 = no
  // limit (and nothing advertised in CONNACK).
  maximumPacketSize: 0,
  // MQTT 5.0: maximum number of unacknowledged QoS 1/2 PUBLISH a client may
  // have in flight towards the broker. 0 = not advertised (defaults to 65535).
  receiveMaximum: 0,
  // MQTT 5.0: upper bound (seconds) on the Session Expiry Interval a client may
  // request. A larger requested value (including 0xFFFFFFFF "never") is clamped
  // to this. Bounds how long per-client session-expiry / will-delay timers and
  // their persisted state live, limiting single-source accumulation. 0 = no cap.
  maximumSessionExpiryInterval: 0,
  // MQTT 5.0: cap on the number of pending session-expiry timers (and, applied
  // separately, delayed-will timers) the broker holds at once. Beyond it, a
  // newly disconnecting session is expired immediately and a new delayed will is
  // published immediately, bounding memory under identity-cycling abuse without
  // evicting already-pending entries. 0 = unlimited.
  maximumPendingSessions: 0
}
const version = pkg.version

// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1 ms, firing
// almost immediately. MQTT 5.0 session-expiry / will-delay intervals are uint32
// seconds (up to ~136 years), so a raw setTimeout would wipe long-lived
// sessions and fire delayed wills early.
const MAX_TIMEOUT_MS = 2147483647

// Arms a timer that survives delays beyond setTimeout's cap by re-arming in
// chunks. Returns a handle whose clear() cancels whichever chunk is pending.
function armLongTimer (delayMs, onFire) {
  let timer
  const schedule = (remaining) => {
    const chunk = Math.min(remaining, MAX_TIMEOUT_MS)
    timer = setTimeout(() => {
      const left = remaining - chunk
      if (left > 0) {
        schedule(left)
      } else {
        onFire()
      }
    }, chunk)
    if (typeof timer.unref === 'function') timer.unref()
  }
  schedule(delayMs)
  return { clear () { clearTimeout(timer) } }
}

export class Aedes extends EventEmitter {
  constructor (opts) {
    super()
    const that = this

    opts = Object.assign({}, defaultOptions, opts)
    this.opts = opts
    this.id = opts.id || randomUUID()
    // +1 when construct a new aedes-packet
    // internal track for last brokerCounter
    this.counter = 0
    this.queueLimit = opts.queueLimit
    this.connectTimeout = opts.connectTimeout
    this.keepaliveLimit = opts.keepaliveLimit
    this.maxClientsIdLength = opts.maxClientsIdLength
    this.topicAliasMaximum = opts.topicAliasMaximum
    this.maximumPacketSize = opts.maximumPacketSize
    this.receiveMaximum = opts.receiveMaximum
    this.maximumSessionExpiryInterval = opts.maximumSessionExpiryInterval
    this.maximumPendingSessions = opts.maximumPendingSessions
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
    // MQTT 5.0: pending session-expiry timers, keyed by clientId. A timer is
    // armed when a client with a finite, non-zero Session Expiry Interval
    // disconnects, and cleared if it reconnects before the timer fires.
    this.expiringSessions = new Map()
    // MQTT 5.0: pending Will Delay Interval timers, keyed by clientId. Armed
    // when a client with a will and a non-zero will delay disconnects, and
    // cleared if it reconnects before the will is published.
    this.delayedWills = new Map()
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

    async function _clearWills () {
      const pAuthorizePublish = promisify(that.authorizePublish).bind(that)
      const pPublish = promisify(that.publish).bind(that)
      const batchSize = 16 // default highWatermark for Writable in ObjectMode

      async function checkAndPublish (will) {
        const notPublish = that.brokers[will.brokerId] !== undefined && that.brokers[will.brokerId] + (3 * opts.heartbeatInterval) >= Date.now()
        if (notPublish) {
          return
        }
        // randomize this, so that multiple brokers
        // do not publish the same wills at the same time
        const client = that.clients[will.clientId] || null
        await pAuthorizePublish(client, will)
        await pPublish(will)
        await that.persistence.delWill({
          id: will.clientId,
          brokerId: will.brokerId
        })
      }

      // delete old brokers
      for (const broker in that.brokers) {
        if (that.brokers[broker] + (3 * opts.heartbeatInterval) < Date.now()) {
          delete that.brokers[broker]
        }
      }

      const wills = that.persistence.streamWill(that.brokers)
      for await (const promises of batch(wills, checkAndPublish, batchSize)) {
        await Promise.all(promises)
      }
    }

    this._clearWillInterval = setInterval(() => {
      _clearWills().catch(err => {
        that.emit('error', err)
      })
    }, opts.heartbeatInterval * 4)
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
    // MQTT 5.0 Message Expiry Interval: record the absolute expiry so that a
    // message dropped into the offline queue can be discarded (or have its
    // remaining lifetime recomputed) when it is finally delivered. The
    // properties check is first so v3/v4 publishes (no `properties`) short-
    // circuit off the fast path without the extra field reads.
    if (p.properties?.messageExpiryInterval > 0 && p.messageExpiry === undefined) {
      p.messageExpiry = Date.now() + (p.properties.messageExpiryInterval * 1000)
    }
    const publishFuncs = p.qos > 0 ? publishFuncsQoS : publishFuncsSimple

    runSeries(new PublishState(this, client, packet), publishFuncs, p, done)
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
      // [MQTT-3.1.4-2] An existing session with the same client id is taken
      // over; tell the old v5 connection with reason code 0x8E (Session taken
      // over) before closing it.
      this.clients[client.id].disconnect({ reasonCode: ReasonCodes.SESSION_TAKEN_OVER }, function closeClient () {
        that._finishRegisterClient(client)
      })
    } else {
      this._finishRegisterClient(client)
    }
  }

  _finishRegisterClient (client) {
    // Reconnecting before the session expires cancels the pending expiry and
    // any delayed will (the session continues, so the will is not sent).
    this.clearSessionExpiry(client.id)
    this.clearDelayedWill(client.id)
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

  // MQTT 5.0: clamp a client-requested Session Expiry Interval (seconds) to the
  // broker maximum. Bounds the lifetime of the per-client expiry/will timers and
  // persisted state a single source can pin, limiting memory accumulation from a
  // client cycling identities with large intervals. 0 = no cap.
  clampSessionExpiry (interval) {
    const max = this.maximumSessionExpiryInterval
    return max > 0 && interval > max ? max : interval
  }

  // MQTT 5.0 Session Expiry. Called when a client disconnects: decides whether
  // the session's persisted state (subscriptions, queued messages, will) is
  // kept, wiped immediately, or wiped after the Session Expiry Interval.
  scheduleSessionExpiry (client) {
    if (this.closed) return
    // v3/v4 keep the legacy behavior (clean wiped on next connect, non-clean
    // kept indefinitely), so there is no timed expiry to arrange.
    if (client.version !== 5) return

    const interval = client.sessionExpiryInterval
    if (interval >= SESSION_NEVER_EXPIRES) {
      // 0xFFFFFFFF: the session is retained until explicitly taken over.
      return
    }
    if (interval === 0) {
      // The session ends when the network connection closes.
      this._wipeSession(client)
      return
    }
    // Count cap: when the broker is already holding the maximum number of
    // pending expiry timers, end this session now instead of queuing another.
    // Denying the newest (rather than evicting an oldest) bounds memory without
    // dropping already-established sessions. 0 = unlimited.
    if (this.maximumPendingSessions > 0 &&
        !this.expiringSessions.has(client.id) &&
        this.expiringSessions.size >= this.maximumPendingSessions) {
      this._wipeSession(client)
      return
    }

    const that = this
    const timer = armLongTimer(interval * 1000, function expireSession () {
      that.expiringSessions.delete(client.id)
      // Identity guard: if the id has since been re-registered (reconnect /
      // takeover), a live session now owns it — do not wipe it. [data integrity]
      if (that.clients[client.id]) return
      that._wipeSession(client)
    })
    this.expiringSessions.set(client.id, timer)
  }

  clearSessionExpiry (clientId) {
    const timer = this.expiringSessions.get(clientId)
    if (timer) {
      timer.clear()
      this.expiringSessions.delete(clientId)
    }
  }

  // Remove all persisted state belonging to an expired/ended session. Surface
  // persistence failures on the broker 'error' event rather than swallowing
  // them, so a backend that fails to wipe a session is observable.
  _wipeSession (client) {
    const that = this
    const onErr = (err) => that.emit('error', err)
    this.persistence.cleanSubscriptions(client).then(noop, onErr)
    this.persistence.delWill({ id: client.id, brokerId: this.id }).then(noop, onErr)
    client.emptyOutgoingQueue(noop)
  }

  // MQTT 5.0 Will Delay Interval: publish the will after `delaySeconds`
  // instead of immediately, unless the client reconnects first.
  scheduleWill (client, will, delaySeconds) {
    if (this.closed) return
    // Count cap (see scheduleSessionExpiry): when already holding the maximum
    // number of delayed wills, publish this one now instead of queuing a timer.
    if (this.maximumPendingSessions > 0 &&
        !this.delayedWills.has(client.id) &&
        this.delayedWills.size >= this.maximumPendingSessions) {
      this.publishWill(client, will)
      return
    }
    const that = this
    const timer = armLongTimer(delaySeconds * 1000, function fireWill () {
      that.delayedWills.delete(client.id)
      // Identity guard: a reconnect under the same id cancels the delayed will;
      // if the id is live again, skip publishing it. [MQTT-3.1.3-9]
      if (that.clients[client.id]) return
      that.publishWill(client, will)
    })
    this.delayedWills.set(client.id, timer)
  }

  clearDelayedWill (clientId) {
    const timer = this.delayedWills.get(clientId)
    if (timer) {
      timer.clear()
      this.delayedWills.delete(clientId)
    }
  }

  // Authorize and publish a client's will, then remove it from persistence.
  publishWill (client, will) {
    const that = this
    this.authorizePublish(client, will, function (err) {
      if (err) { return cleanup() }
      that.publish(will, client, cleanup)
    })
    function cleanup () {
      that.persistence.delWill({ id: client.id, brokerId: that.id })
        .then(noop, (err) => that.emit('error', err))
    }
  }

  close (cb = noop) {
    const that = this
    if (this.closed) {
      return cb()
    }
    this.closed = true
    clearInterval(this._heartbeatInterval)
    clearInterval(this._clearWillInterval)
    for (const timer of this.expiringSessions.values()) {
      timer.clear()
    }
    this.expiringSessions.clear()
    for (const timer of this.delayedWills.values()) {
      timer.clear()
    }
    this.delayedWills.clear()
    const promises = []
    for (const clientId of Object.keys(this.clients)) {
      promises.push(closeClient(this.clients[clientId]))
    }
    Promise.all(promises).finally(() => {
      that.emit('closed')
      that.mq.close(cb)
    })
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
  const enqueuer = new DoEnqueues()

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

async function closeClient (clientInstance) {
  return new Promise((resolve) => {
    // [MQTT-3.14.4-1] notify v5 clients with reason code 0x8B (Server shutting
    // down) before closing; v3/v4 clients are just closed by disconnect().
    clientInstance.disconnect({ reasonCode: ReasonCodes.SERVER_SHUTTING_DOWN }, resolve)
  })
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

function warnMigrate () {
  throw new Error(
    ` Aedes default export has been removed.
 Use 'const aedes = await Aedes.createBroker()' instead.
 See: https://github.com/moscajs/aedes/docs/MIGRATION.MD
 `)
}

export default warnMigrate
