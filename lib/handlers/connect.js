import { randomUUID } from 'node:crypto'
import { pipeline } from 'stream'
import mqtt from 'mqtt-packet'
import write from '../write.js'
import QoSPacket from '../qos-packet.js'
import { runSeries, through, truncate } from '../utils.js'
import handleSubscribe from './subscribe.js'
import { startEnhancedAuth, validAuthProperties } from './auth.js'
import { SESSION_NEVER_EXPIRES, RECEIVE_MAXIMUM_DEFAULT, CONNACK_FAILURE_REASON_CODES, ReasonCodes } from '../constants.js'

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
// exceeded) is aedes-specific; CONNECTION_RATE_EXCEEDED (0x9F) is the
// nearest standard reason code.
const connackReasonCodes = [
  ReasonCodes.SUCCESS, // 0 success
  ReasonCodes.UNSUPPORTED_PROTOCOL_VERSION, // 1 unacceptable protocol version
  ReasonCodes.CLIENT_IDENTIFIER_NOT_VALID, // 2 identifier rejected
  ReasonCodes.SERVER_UNAVAILABLE, // 3 server unavailable
  ReasonCodes.BAD_USERNAME_OR_PASSWORD, // 4 bad user name or password
  ReasonCodes.NOT_AUTHORIZED, // 5 not authorized
  ReasonCodes.CONNECTION_RATE_EXCEEDED // 6 keep alive limit exceeded (aedes-specific)
]

class Connack {
  constructor (arg, version) {
    this.cmd = 'connack'
    this.sessionPresent = arg.sessionPresent
    if (version === 5) {
      // [MQTT-3.2.2-6] CONNACK uses a reason code in MQTT 5.0. An explicit
      // arg.reasonCode (e.g. 0x82 Protocol Error) overrides the v3/v4 map.
      const reasonCode = arg.reasonCode ?? connackReasonCodes[arg.returnCode] ?? ReasonCodes.UNSPECIFIED_ERROR
      // [MQTT-3.2.2-8] Clamp here — the single funnel every CONNACK passes through —
      // so no rejection source (rejectConnect, the authenticate `negate` tail, the
      // enhanced-auth onFailure) can emit an illegal code.
      this.reasonCode = clampConnackReasonCode(reasonCode)
      if (arg.properties) {
        this.properties = arg.properties
      }
    } else {
      this.returnCode = arg.returnCode
    }
  }
}

// Builds the MQTT 5.0 CONNACK properties advertising broker capabilities.
// Always returns a fresh object: [MQTT-3.2.2-13] requires every v5 CONNACK to
// advertise that shared subscriptions are unavailable.
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

// [#1091] Resolve the broker's Response Information for this client. The
// `responseInformation` broker option is either a static string or a
// `(client) => string | undefined` function. Returns undefined (⇒ the property
// is omitted) when not configured, the function opts out, or the function
// throws — a per-client lookup failure degrades to no property rather than
// breaking the CONNACK (runSeries has no per-action try/catch).
function resolveResponseInformation (client) {
  const ri = client.broker.responseInformation
  if (ri == null) return undefined
  try {
    const value = typeof ri === 'function' ? ri(client) : ri
    return value == null ? undefined : value
  } catch (err) {
    // Surface the resolver failure (a resolver that throws for every client
    // would otherwise omit the property forever, undiagnosably) but keep the
    // property omitted so the handshake proceeds. Use the broker `clientError`
    // event, NOT client.emit('error') — the latter routes to _onError which
    // destroys the connection, which would break the very CONNACK we're mid-way
    // through building.
    client.broker.emit('clientError', client, err)
    return undefined
  }
}

// [#838] A Server Reference is only meaningful with a redirect reason code
// (0x9C Use another server / 0x9D Server moved). Clamp anything else the hook
// set — pairing serverReference with e.g. 0x00 or 0x97 would otherwise emit a
// non-redirect CONNACK carrying a reference the spec binds only to 0x9C/0x9D.
function redirectReasonCode (err) {
  return err.reasonCode === ReasonCodes.SERVER_MOVED
    ? ReasonCodes.SERVER_MOVED
    : ReasonCodes.USE_ANOTHER_SERVER
}

// [MQTT-3.2.2-8] Clamp a reason code to one a CONNACK may legally carry (Table 3-1):
// only SUCCESS (0x00) or a Table-3-1 failure code. A real reason code not valid on
// CONNACK (0x8E, 0x93, …) or any other non-zero-success value becomes 0x87. Applied
// in the Connack funnel so every rejection source (rejectConnect, negate, onFailure)
// is covered once.
function clampConnackReasonCode (reasonCode) {
  return reasonCode === ReasonCodes.SUCCESS || CONNACK_FAILURE_REASON_CODES.has(reasonCode)
    ? reasonCode
    : ReasonCodes.NOT_AUTHORIZED
}

// A hook's `err.reasonString` is copied verbatim onto the rejection CONNACK and
// reaches the UNAUTHENTICATED client, so it must be a bounded string — a non-string
// (a DB error object, a number) or a megabyte of text would be a wire hazard / info
// leak. Both the authenticate `negate` and the enhanced-auth `onFailure` paths use
// this, so the same hook error shape produces the same wire result on either path.
function rejectReasonString (err) {
  return typeof err.reasonString === 'string' ? truncate(err.reasonString, 256) : undefined
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
      return
    }
    // [#838] Connect-time server redirect: a preConnect error carrying a
    // serverReference redirects a v5 client to another server via a CONNACK
    // (default 0x9C Use another server; 0x9D Server moved via err.reasonCode).
    // client.version isn't assigned before init(), so key off the CONNECT.
    // Keep `connecting` true here so write() still emits the CONNACK; clear it
    // once the packet is on the wire.
    if (err && err.serverReference && packet.protocolVersion === 5) {
      rejectConnect(client, {
        error: err,
        reasonCode: redirectReasonCode(err),
        properties: { serverReference: err.serverReference },
        version: 5
      }, function redirected (e) {
        client.connecting = false
        done(e)
      })
      return
    }
    client.connecting = false
    done(err)
  }
}

// Reject a CONNECT: send the rejection CONNACK and finish the connect with the
// error. Centralizes the near-identical rejection guards in init(). A v5
// `reasonCode` is also attached to the error (matching the `errorCode`
// convention for v3/v4 return codes) so a reject storm is diagnosable from the
// error alone, without parsing the message text. [observability]
function rejectConnect (client, { error, returnCode = 0, reasonCode, properties, version }, done) {
  if (reasonCode !== undefined) {
    error.reasonCode = reasonCode
  }
  doConnack(
    { client, returnCode, reasonCode, properties, sessionPresent: false, version },
    done.bind(null, error))
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
  // [MQTT-3.1.3-7/8] v3/v4: a zero-byte ClientId requires CleanSession = 1; a
  // zero-byte ClientId with CleanSession 0 must be rejected with return code
  // 0x02 (identifier rejected) and the connection closed. MQTT 5.0 is
  // intentionally different — it allows a zero-byte ClientId and assigns one
  // (reported via the Assigned Client Identifier property, see below) — so this
  // guard is gated on protocolVersion < 5.
  if (packet.protocolVersion < 5 && clientId.length === 0 && packet.clean === false) {
    returnCode = 2
  }
  if (returnCode > 0) {
    const error = new Error(errorMessages[returnCode])
    error.errorCode = returnCode
    // The client is rejected before it is fully accepted, so client.version
    // is intentionally left unset; pass the requested version explicitly so
    // the rejection CONNACK is still serialized with the right protocol.
    rejectConnect(client, { error, returnCode, version: packet.protocolVersion }, done)
    return
  }

  // [MQTT-3.1.2-22] A Receive Maximum of 0 is a Protocol Error; reject the
  // CONNECT with a 0x82 (Protocol Error) CONNACK rather than accepting it.
  if (packet.protocolVersion === 5 && packet.properties?.receiveMaximum === 0) {
    rejectConnect(client, {
      error: new Error('Receive Maximum must not be 0'),
      reasonCode: ReasonCodes.PROTOCOL_ERROR,
      version: 5
    }, done)
    return
  }

  // [§3.1.2.11.4] A Maximum Packet Size of 0 is a Protocol Error (a duplicated
  // property also decodes to an array). The AUTH/CONNACK paths read this value, and
  // every `> 0` guard would read a 0 as "no limit" — reject rather than silently
  // treat an invalid value as unlimited.
  const maxPacketSize = packet.properties?.maximumPacketSize
  if (packet.protocolVersion === 5 && maxPacketSize !== undefined &&
      (typeof maxPacketSize !== 'number' || maxPacketSize === 0)) {
    rejectConnect(client, {
      error: new Error('Maximum Packet Size must not be 0'),
      reasonCode: ReasonCodes.PROTOCOL_ERROR,
      version: 5
    }, done)
    return
  }

  // [§3.1.2.11.10] Authentication Data without an Authentication Method is a
  // Protocol Error.
  if (packet.protocolVersion === 5 && packet.properties?.authenticationData !== undefined &&
      packet.properties?.authenticationMethod === undefined) {
    rejectConnect(client, {
      error: new Error('authentication data without authentication method'),
      reasonCode: ReasonCodes.PROTOCOL_ERROR,
      version: 5
    }, done)
    return
  }

  // [§3.1.2.11.9] Shape-check the auth properties at the trust boundary (a
  // duplicated v5 property decodes to an array — a Protocol Error — that would
  // otherwise reach `authenticateEnhanced` as method: string[] / data: Buffer[]).
  // The same validator runs on every continuation AUTH (see auth.js). [#833]
  if (packet.protocolVersion === 5 && !validAuthProperties(packet.properties)) {
    rejectConnect(client, {
      error: new Error('malformed authentication method or data'),
      reasonCode: ReasonCodes.PROTOCOL_ERROR,
      version: 5
    }, done)
    return
  }

  // §4.12 Enhanced authentication: a CONNECT carrying an Authentication Method is
  // handled by the `authenticateEnhanced` hook (the AUTH-packet exchange, driven
  // from the authenticate step below). [#833] When no handler is configured it
  // would otherwise be silently downgraded to username/password auth, so reject
  // it with 0x8C. Gate on `typeof === 'function'` so a mis-set option (e.g.
  // `authenticateEnhanced: true`) is treated as "no handler" rather than reaching
  // the call site.
  if (packet.protocolVersion === 5 && packet.properties?.authenticationMethod !== undefined &&
      typeof client.broker.authenticateEnhanced !== 'function') {
    // Distinguish the two causes (both → CONNACK 0x8C) so the most likely rollout
    // failure — the hook simply not wired up — is not indistinguishable from a
    // client asking for a method the broker can't do. Name the requested method, but
    // truncate it: it's unbounded, unauthenticated, attacker-controlled bytes going
    // into a logged error (log-injection / log-volume surface).
    const requestedMethod = truncate(packet.properties.authenticationMethod)
    const message = client.broker.authenticateEnhanced == null
      ? `enhanced authentication requested (method '${requestedMethod}') but no authenticateEnhanced handler is configured`
      : `bad authentication method '${requestedMethod}' (authenticateEnhanced is not a function)`
    rejectConnect(client, {
      error: new Error(message),
      reasonCode: ReasonCodes.BAD_AUTHENTICATION_METHOD,
      version: 5
    }, done)
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
  client._assignedClientId = clientId ? undefined : client.id
  // MQTT 5.0 Server Keep Alive: when the client's keepalive is unset or above
  // the broker limit, impose the broker's limit instead of rejecting.
  if (packet.protocolVersion === 5 && client.broker.keepaliveLimit &&
      (!packet.keepalive || packet.keepalive > client.broker.keepaliveLimit)) {
    client._serverKeepAlive = client.broker.keepaliveLimit
  }
  // MQTT 5.0 decouples two axes that v3/v4 folded into the clean flag:
  //  - whether to resume a prior session (driven by Clean Start = packet.clean,
  //    still consulted directly by fetchSubs below), and
  //  - whether this session is persisted past disconnect (driven by the
  //    Session Expiry Interval). `client.clean` now tracks the persistence
  //    axis: a session that does not outlive the connection is "clean".
  const requestedSessionExpiry = sessionExpiryFromConnect(packet)
  // Remember the CONNECT value (pre-clamp) so a later DISCONNECT can enforce
  // [MQTT-3.14.4-3]: a non-zero Session Expiry on DISCONNECT is invalid when the
  // CONNECT declared 0.
  client._connectSessionExpiryInterval = requestedSessionExpiry
  client.sessionExpiryInterval = client.broker.clampSessionExpiry(requestedSessionExpiry)
  // [MQTT-3.2.2-3.2 / §3.2.2.3.2] If the broker applied a different Session
  // Expiry Interval than requested (here, clamped down), it must echo the
  // applied value in the CONNACK so the client knows its real session lifetime.
  client._sessionExpiryClamped = packet.protocolVersion === 5 &&
    client.sessionExpiryInterval !== requestedSessionExpiry
  client.clean = client.sessionExpiryInterval === 0
  // [MQTT-3.1.2-4] Clean Start discards any existing session. `client.clean`
  // tracks the *persistence* axis (does the new session outlive the connection),
  // which can be false here while Clean Start is true (clean start + non-zero
  // expiry). Keep the Clean Start flag so the prior session's queued messages
  // are dropped at connect, not delivered to the fresh session.
  client._cleanStart = packet.clean === true
  // MQTT 5.0 flow-control limits the client imposes on the broker. Both are
  // currently ADVISORY: the broker stores them but does not enforce them on the
  // delivery path — it will not split/skip an outbound PUBLISH that exceeds the
  // client's maximumPacketSize, nor cap outbound in-flight to receiveMaximum.
  // (Consistent posture; enforcement is a planned follow-up.)
  client.maximumPacketSize = packet.properties?.maximumPacketSize // bytes, broker->client
  client.receiveMaximum = packet.properties?.receiveMaximum ?? RECEIVE_MAXIMUM_DEFAULT // in-flight QoS 1/2
  // [#833] MQTT 5.0 Enhanced Authentication: the Authentication Method (§4.12) is
  // constant across the exchange, and marks a client as eligible for later
  // re-authentication. Absent for username/password clients; v5 only (a v3/v4
  // CONNECT has no properties, so this would always be undefined there).
  client._authenticationMethod = packet.protocolVersion === 5 ? packet.properties?.authenticationMethod : undefined
  // MQTT 5.0 Request Problem Information [MQTT-3.1.2-29]: when false the broker
  // must not send a Reason String or User Properties on packets other than
  // PUBLISH/CONNACK/DISCONNECT. mqtt-packet decodes the byte property as a
  // boolean; absent ⇒ true (allowed).
  client._requestProblemInformation = packet.properties?.requestProblemInformation !== false
  // MQTT 5.0 Request Response Information [§3.1.2.11.6]: the client asks the
  // broker to return Response Information in the CONNACK. Default (absent) is
  // false — the broker only returns it on explicit request.
  client._requestResponseInformation = packet.properties?.requestResponseInformation === true
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
  const packet = this.packet
  client.pause()

  // Runs the standard username/password `authenticate` hook and its reject/redirect
  // handling (the `negate` continuation below). Called directly for a normal
  // CONNECT, and CHAINED after a successful enhanced-auth exchange — so policy that
  // lives only in `authenticate` (IP/TLS checks, setting `client.user`, per-IP rate
  // limits) still runs for a client that authenticated via §4.12, instead of being
  // silently skipped. The default hook allows all, so this is a no-op unless the
  // operator configured one. [#833]
  function runStandardAuthenticate () {
    client.broker.authenticate(client, packet.username, packet.password, negate)
  }

  // [#833] Enhanced authentication: a CONNECT with an Authentication Method and a
  // configured hook runs the AUTH-packet exchange. The exchange spans multiple
  // packets (auth.js); on success it CHAINS the standard `authenticate` hook (see
  // above), on failure it sends a rejection CONNACK like the username/password path.
  if (client.version === 5 && client._authenticationMethod !== undefined && typeof client.broker.authenticateEnhanced === 'function') {
    startEnhancedAuth(client, packet, {
      method: client._authenticationMethod,
      onSuccess () {
        runStandardAuthenticate()
      },
      onFailure (err) {
        // A hook may reject (or throw) with a non-Error — coerce so the reasonCode
        // / errorCode / reasonString assignments below can't throw a TypeError.
        // Preserve the original value as `cause` so it isn't lost (cf. write.js).
        if (err === null || typeof err !== 'object') {
          err = new Error('enhanced authentication rejected', { cause: err })
        }
        arg.client = client
        arg.returnCode = 5
        // [#838] Server redirect: like preConnect and authenticate, an enhanced-auth
        // rejection carrying a serverReference redirects a v5 client to another
        // server via the CONNACK (default 0x9C Use another server; 0x9D Server moved
        // via err.reasonCode). Routed through the same redirectReasonCode() clamp so
        // the redirect codes are only ever paired WITH a Server Reference.
        if (client.version === 5 && err.serverReference) {
          arg.reasonCode = redirectReasonCode(err)
          arg.properties = { serverReference: err.serverReference }
        } else {
          // A rejection MUST carry a FAILURE code (Connack's clamp keeps 0x00 for
          // success CONNACKs, so a hook rejecting with a < 0x80 code would otherwise
          // ride through as success). Also maps an illegal code and a bare 0x9C/0x9D
          // (redirect code with no serverReference to justify it) to 0x87.
          arg.reasonCode = CONNACK_FAILURE_REASON_CODES.has(err.reasonCode) &&
            err.reasonCode !== ReasonCodes.USE_ANOTHER_SERVER &&
            err.reasonCode !== ReasonCodes.SERVER_MOVED
            ? err.reasonCode
            : ReasonCodes.NOT_AUTHORIZED
          const reasonString = rejectReasonString(err)
          if (reasonString !== undefined) arg.properties = { reasonString }
        }
        err.errorCode = arg.returnCode
        // Mirror the resolved code onto the error (as rejectConnect / the redirect
        // path do) so a connectionError listener can see which CONNACK the client
        // got, and tell a hook rejection from an aedes-generated one, without
        // string-matching the message.
        err.reasonCode = arg.reasonCode
        doConnack(arg, client.close.bind(client, done.bind(null, err)))
      }
    })
    return
  }

  runStandardAuthenticate()

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
    // [#838] Server redirect: an authenticate error carrying a serverReference
    // redirects a v5 client to another server via the CONNACK — default 0x9C
    // (Use another server); the hook may set 0x9D (Server moved) via
    // err.reasonCode. §4.11
    if (client.version === 5 && err.serverReference) {
      arg.reasonCode = redirectReasonCode(err)
      arg.properties = { serverReference: err.serverReference }
      // Attach the redirect code to the emitted error too, matching the
      // preConnect path (rejectConnect) so the reason is diagnosable from the
      // connectionError alone, not just the CONNACK.
      err.reasonCode = arg.reasonCode
    } else {
      // Forward a validated Reason String, consistently with the enhanced-auth
      // onFailure path (the same hook error shape must behave the same on either).
      const reasonString = rejectReasonString(err)
      if (reasonString !== undefined) arg.properties = { reasonString }
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
  const keepalive = client._serverKeepAlive ?? this.packet.keepalive
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
  // A pipelined DISCONNECT (or a plain socket drop) during the async connect
  // pipeline — preConnect, the setImmediate(init) hop, or an async fetchSubs /
  // restoreSubs / storeWill — can tear the connection down before we reach here.
  // `enqueue` dispatches a DISCONNECT immediately (it must not be parked behind a
  // CONNACK that may never come), so its conn.destroy() can land mid-pipeline.
  // Registering now would insert a dead client into broker.clients that close()
  // already skipped (close()'s unregister is gated on the client being registered),
  // leaking it forever — inflating connectedClients, firing a `client` event with
  // no matching `clientDisconnect`, and never freeing the socket's Client. Abort
  // the pipeline instead. `conn.destroyed` is set synchronously by destroy(), so it
  // catches the window before the async close() flips `closed`. Mirrors the
  // enhanced-auth finishAuth `closed || conn.destroyed` liveness guard. [#833]
  if (client.closed || client.conn.destroyed) {
    done(new Error('connection closed during connect'))
    return
  }
  client.broker.registerClient(client)
  done()
}

function doConnack (arg, done) {
  const client = arg.client || this.client
  // arg.version is set for pre-acceptance rejections (when client.version is
  // not assigned yet); otherwise fall back to the negotiated client.version.
  const version = arg.version ?? client.version
  // Advertise broker capabilities and negotiated handshake values on a
  // successful v5 connection (never on a rejection carrying an explicit reason).
  // `arg.reasonCode === undefined` (not `!arg.reasonCode`): 0x00 SUCCESS is a
  // valid explicit reason code and must not be conflated with "none passed".
  if (version === 5 && arg.returnCode === 0 && arg.reasonCode === undefined && !arg.properties) {
    // connackProperties() returns a fresh object, so per-client overrides can be
    // written straight onto it — no defensive copy needed.
    arg.properties = connackProperties(client.broker)
    // [#1091] Response Information: returned only when the client asked for it
    // (requestResponseInformation) and the broker is configured to provide it
    // (server MAY, §3.2.2.3.15).
    const responseInformation = client._requestResponseInformation
      ? resolveResponseInformation(client)
      : undefined
    if (client._assignedClientId || client._serverKeepAlive || client._sessionExpiryClamped || responseInformation !== undefined) {
      if (client._assignedClientId) {
        arg.properties.assignedClientIdentifier = client._assignedClientId
      }
      if (client._serverKeepAlive) {
        arg.properties.serverKeepAlive = client._serverKeepAlive
      }
      if (client._sessionExpiryClamped) {
        arg.properties.sessionExpiryInterval = client.sessionExpiryInterval
      }
      if (responseInformation !== undefined) {
        arg.properties.responseInformation = responseInformation
      }
    }
    // [#833][MQTT-4.12.0-5] A successful CONNACK that completes an enhanced-auth
    // exchange MUST echo the Authentication Method (strict v5 clients reject a
    // CONNACK that omits it), plus any final Authentication Data. Merged into the
    // generated properties (not passed as arg.properties, which would skip this
    // whole capability block — sharedSubscriptionAvailable, etc.).
    if (client._authenticationMethod !== undefined) {
      arg.properties.authenticationMethod = client._authenticationMethod
      if (client._authenticationData !== undefined) {
        arg.properties.authenticationData = client._authenticationData
        // Single-use: release it once copied into the CONNACK so a (possibly
        // pooled) hook Buffer isn't retained for the whole session — and doesn't
        // ride on the client object through every client/clientError event.
        client._authenticationData = undefined
      }
    }
  }
  const connack = new Connack(arg, version)
  // [MQTT-3.1.2-24] The Server MUST NOT send a CONNACK exceeding the client's
  // Maximum Packet Size. mqtt-packet's connack() writer doesn't apply the size-aware
  // helper (unlike auth/disconnect/publish), so enforce it here. The only
  // client-uncontrolled, unbounded field the CONNACK carries is the enhanced-auth
  // final Authentication Data; measure the packet only when it's present, and on
  // overflow drop that optional field (the client already completed the exchange, so
  // the CONNACK Auth Data is informational) rather than emit an oversize packet the
  // client MUST reject. The rest of the CONNACK is bounded by broker config.
  if (client.maximumPacketSize > 0 && connack.properties?.authenticationData !== undefined) {
    // Wrap the probe: runSeries has no per-action try/catch, so a serializer throw
    // here would escape into the readable handler / persistence chain and take the
    // process down. authenticationData is Buffer-validated at the auth boundary, so a
    // throw is not expected — but on this path defence in depth is cheap. On overflow
    // drop the (informational) final data; re-measure since the CONNACK still carries
    // assignedClientIdentifier / responseInformation etc.
    try {
      if (mqtt.generate(connack, { protocolVersion: version }).length > client.maximumPacketSize) {
        connack.properties = { ...connack.properties, authenticationData: undefined }
        /* c8 ignore next 3 -- defensive: needs a maximumPacketSize smaller than the CONNACK's own broker-set properties */
        if (mqtt.generate(connack, { protocolVersion: version }).length > client.maximumPacketSize) {
          client.broker.emit('clientError', client, new Error('CONNACK exceeds the client Maximum Packet Size even without Authentication Data'))
        }
      }
    /* c8 ignore start -- defensive: authenticationData is Buffer-validated at the auth boundary, so the generate can't throw here */
    } catch (e) {
      // A malformed property slipped the boundary check — drop the optional final
      // data and let the write proceed rather than crash.
      connack.properties = { ...connack.properties, authenticationData: undefined }
    }
    /* c8 ignore stop */
  }
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
      const now = Date.now()
      if (data.messageExpiry !== undefined && data.messageExpiry > now) {
        data.properties = data.properties || {}
        data.properties.messageExpiryInterval = Math.ceil((data.messageExpiry - now) / 1000)
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

  // [MQTT-3.1.2-4] On Clean Start the prior session is discarded, so its queued
  // messages must be dropped even when the new session is itself persistable
  // (clean start + non-zero Session Expiry → client.clean === false).
  if (client.clean || client._cleanStart || !authorized || expired) {
    persistence.outgoingClearMessageId(client, packet)
      .then(packet => next(null, packet), next)
  } else {
    write(client, packet, next)
  }
}

export default handleConnect
