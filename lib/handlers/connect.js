import { randomUUID } from 'node:crypto'
import { pipeline } from 'stream'
import write from '../write.js'
import QoSPacket from '../qos-packet.js'
import { runSeries, through } from '../utils.js'
import handleSubscribe from './subscribe.js'
import { SESSION_NEVER_EXPIRES } from '../constants.js'

// Resolves the effective Session Expiry Interval (in seconds) from a CONNECT.
// For MQTT 5.0 it comes from the property (default 0 = ends with the network
// connection). For v3/v4 it is derived from the clean flag: a clean session is
// ephemeral (0), a persistent session never expires.
function sessionExpiryFromConnect (packet) {
  if (packet.protocolVersion === 5) {
    return packet.properties?.sessionExpiryInterval ?? 0
  }
  return packet.clean ? 0 : SESSION_NEVER_EXPIRES
}

// Maps the legacy MQTT 3.1/3.1.1 CONNACK return codes (index) to the
// equivalent MQTT 5.0 CONNACK reason codes. Index 6 (keep alive limit
// exceeded) is aedes-specific; 0x9F (connection rate exceeded) is the
// nearest standard reason code.
const connackReasonCodes = [0x00, 0x84, 0x85, 0x88, 0x86, 0x87, 0x9F]

class Connack {
  constructor (arg, version) {
    this.cmd = 'connack'
    this.sessionPresent = arg.sessionPresent
    if (version === 5) {
      // [MQTT-3.2.2-6] CONNACK uses a reason code in MQTT 5.0
      this.reasonCode = connackReasonCodes[arg.returnCode] ?? 0x80
      if (arg.properties) {
        this.properties = arg.properties
      }
    } else {
      this.returnCode = arg.returnCode
    }
  }
}

// Builds the MQTT 5.0 CONNACK properties advertising broker capabilities.
// Returns undefined when there is nothing to advertise so no properties block
// is emitted.
function connackProperties (broker) {
  const properties = {}
  // Capabilities that default to "available" (retain, wildcard subscriptions,
  // subscription identifiers, max QoS 2) are not advertised.
  //
  // Shared subscriptions are explicitly advertised as NOT available: aedes can
  // run as a cluster of instances, and shared-subscription group state would be
  // per-instance, so a shared message would be delivered once per instance
  // holding a group member rather than once cluster-wide. Until a cluster-aware
  // implementation lands, [MQTT-3.2.2-13] requires we tell clients it is off.
  properties.sharedSubscriptionAvailable = false
  if (broker.topicAliasMaximum > 0) {
    properties.topicAliasMaximum = broker.topicAliasMaximum
  }
  // Advisory only: maximumPacketSize is enforced on inbound frames, but
  // receiveMaximum (inbound in-flight QoS 1/2 window) is advertised without
  // broker-side enforcement. See docs/Aedes.md.
  if (broker.maximumPacketSize > 0) {
    properties.maximumPacketSize = broker.maximumPacketSize
  }
  if (broker.receiveMaximum > 0) {
    properties.receiveMaximum = broker.receiveMaximum
  }
  return properties
}

class ClientPacketStatus {
  constructor (client, packet) {
    this.client = client
    this.packet = packet
  }
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
  'not authorized',
  'keep alive limit exceeded'
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
  let returnCode = 0
  // [MQTT-3.1.2-2]
  if (packet.protocolVersion < 3 || packet.protocolVersion > 5) {
    returnCode = 1
  }
  // MQTT 3.1.0 allows <= 23 client id length
  if (packet.protocolVersion === 3 && clientId.length > client.broker.maxClientsIdLength) {
    returnCode = 2
  }
  // check if the client keepalive is compatible with broker settings.
  // v3/v4 reject; MQTT 5.0 instead imposes the limit via Server Keep Alive.
  if (client.broker.keepaliveLimit && packet.protocolVersion < 5 && (!packet.keepalive || packet.keepalive > client.broker.keepaliveLimit)) {
    returnCode = 6
  }
  if (returnCode > 0) {
    const error = new Error(errorMessages[returnCode])
    error.errorCode = returnCode
    // The client is rejected before it is fully accepted, so client.version
    // is intentionally left unset; pass the requested version explicitly so
    // the rejection CONNACK is still serialized with the right protocol.
    doConnack(
      { client, returnCode, sessionPresent: false, version: packet.protocolVersion },
      done.bind(this, error))
    return
  }

  client.id = clientId || 'aedes_' + randomUUID()
  client.version = packet.protocolVersion
  // Cache the wire version used for outbound serialization (mqtt-packet only
  // serializes v3/v4/v5; anything else falls back to v4). Stable after CONNECT,
  // so write() reads it instead of recomputing per packet.
  client._wireVersion = (client.version === 3 || client.version === 5) ? client.version : 4
  // MQTT 5.0: when the broker generates the client identifier, report it back
  // to the client via the CONNACK Assigned Client Identifier property.
  client.assignedClientId = clientId ? undefined : client.id
  // MQTT 5.0 Server Keep Alive: when the client's keepalive is unset or above
  // the broker limit, impose the broker's limit instead of rejecting.
  if (packet.protocolVersion === 5 && client.broker.keepaliveLimit &&
      (!packet.keepalive || packet.keepalive > client.broker.keepaliveLimit)) {
    client.serverKeepAlive = client.broker.keepaliveLimit
  }
  // MQTT 5.0 decouples two axes that v3/v4 folded into the clean flag:
  //  - whether to resume a prior session (driven by Clean Start = packet.clean,
  //    still consulted directly by fetchSubs below), and
  //  - whether this session is persisted past disconnect (driven by the
  //    Session Expiry Interval). `client.clean` now tracks the persistence
  //    axis: a session that does not outlive the connection is "clean".
  client.sessionExpiryInterval = sessionExpiryFromConnect(packet)
  client.clean = client.sessionExpiryInterval === 0
  // MQTT 5.0 flow-control limits the client imposes on the broker.
  client.maximumPacketSize = packet.properties?.maximumPacketSize // bytes, broker->client
  client.receiveMaximum = packet.properties?.receiveMaximum ?? 65535 // in-flight QoS 1/2
  client._will = packet.will

  runSeries(
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
  const client = this.client
  // MQTT 5.0 Server Keep Alive (if set) overrides the client's requested value.
  const keepalive = client.serverKeepAlive ?? this.packet.keepalive
  if (keepalive > 0) {
    function keepaliveTimeout () {
      client.broker.emit('keepaliveTimeout', client)
      client.emit('error', new Error('keep alive timeout'))
    }
    // [MQTT-3.1.2-24]
    client._keepaliveInterval = (keepalive * 1500) + 1
    client._keepaliveTimer = setTimeout(keepaliveTimeout, client._keepaliveInterval)
  }
  done()
}

function fetchSubs (arg, done) {
  const client = this.client
  if (!this.packet.clean) {
    const subsClient = {
      id: client.id,
      done,
      arg
    }
    client.broker.persistence.subscriptionsByClient({ id: client.id })
      .then(subs => gotSubs(subs, subsClient), subsClient.done)
    return
  }
  arg.sessionPresent = false // [MQTT-3.2.2-1]
  client.broker.persistence.cleanSubscriptions(client)
    .then(() => done(null), done)
}

function gotSubs (subs, client) {
  client.arg.subs = subs.length > 0 ? subs : null
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
  client.broker.persistence.delWill(client)
    .finally(() => {
      if (client.will) {
        client.broker.persistence.putWill(client, client.will)
          .then(() => done(null, client), done)
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
  // arg.version is set for pre-acceptance rejections (when client.version is
  // not assigned yet); otherwise fall back to the negotiated client.version.
  const version = arg.version ?? client.version
  // Advertise broker capabilities and negotiated handshake values on a
  // successful v5 connection.
  if (version === 5 && arg.returnCode === 0 && !arg.properties) {
    arg.properties = connackProperties(client.broker)
    if (client.assignedClientId || client.serverKeepAlive) {
      arg.properties = { ...arg.properties }
      if (client.assignedClientId) {
        arg.properties.assignedClientIdentifier = client.assignedClientId
      }
      if (client.serverKeepAlive) {
        arg.properties.serverKeepAlive = client.serverKeepAlive
      }
    }
  }
  const connack = new Connack(arg, version)
  write(client, connack, function (err) {
    if (!err) {
      client.broker.emit('connackSent', connack, client)
      client.connackSent = true
    }
    done(err)
  }, version)
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
      // MQTT 5.0 Message Expiry Interval: update the remaining lifetime before
      // delivery (the expired/drop case is handled in emptyQueueFilter, after
      // a message id has been assigned). [MQTT-3.3.2-5]
      if (data.messageExpiry !== undefined && data.messageExpiry > Date.now()) {
        data.properties = data.properties || {}
        data.properties.messageExpiryInterval = Math.ceil((data.messageExpiry - Date.now()) / 1000)
      }
      const packet = new QoSPacket(data, client)
      // Here we are deliberatly passing only the error
      // This is because there is no destination stream so the "client"
      // Object filled the buffer up to the highWaterMark preventing stored messages
      // being sent
      packet.writeCallback = (error, _client) => next(error)
      const filter = (err) => emptyQueueFilter(err, client, packet)
      persistence.outgoingUpdate(client, packet)
        .then(() => filter(null, client, packet), err => filter(err, client, packet))
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

  // MQTT 5.0: drop a message whose expiry interval elapsed while it was queued.
  const expired = packet.messageExpiry !== undefined && packet.messageExpiry <= Date.now()

  if (client.clean || !authorized || expired) {
    persistence.outgoingClearMessageId(client, packet)
      .then(packet => next(null, packet), next)
  } else {
    write(client, packet, next)
  }
}

export default handleConnect
