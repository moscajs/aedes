import mqtt from 'mqtt-packet'

// Frozen, module-level writeToStream options per wire version, indexed by the
// resolved version. Avoids allocating a fresh `{ protocolVersion }` object on
// every write — this is the broker's universal (v3/v4 included) hot path.
const WRITE_OPTS = {
  3: Object.freeze({ protocolVersion: 3 }),
  4: Object.freeze({ protocolVersion: 4 }),
  5: Object.freeze({ protocolVersion: 5 })
}

// [#840] MQTT 5.0 outbound (broker-assigned) Topic Alias. When a client
// advertised a Topic Alias Maximum > 0 in its CONNECT, the broker MAY replace
// the topic of an outbound PUBLISH with a small integer alias to save bandwidth:
// the first PUBLISH on a topic carries the full topic name plus a Topic Alias
// (registering it for the connection); later PUBLISHes on that topic carry an
// empty topic and the alias. §3.3.2.3.4
//
// Returns the object to serialize — a shallow clone when aliased, so the
// caller's packet (which persistence may hold by reference for QoS > 0, and
// which must keep its real topic for resend after reconnect) is never mutated.
// Return a shallow clone of `packet` with `properties.topicAlias` removed. Used to
// scrub a caller/Will-supplied alias off the outbound path without mutating the
// (reference-shared) source packet.
function stripTopicAlias (packet) {
  // Assign `undefined` rather than `delete`: mqtt-packet tolerates it (resolveTopicAlias
  // relies on the same), and `delete` would transition the properties object into
  // dictionary mode, deopting property access.
  return { ...packet, properties: { ...packet.properties, topicAlias: undefined } }
}

function withOutboundTopicAlias (client, packet, version) {
  // `topicAlias` on an outbound PUBLISH is broker-owned: aedes assigns it from its
  // per-connection table. A value already on the packet is NOT trustworthy — it can
  // arrive via the public client.publish(), or via an attacker-set Will property
  // (mqtt-packet round-trips property 0x23 inside will properties, and the inbound
  // resolveTopicAlias only strips it off a live PUBLISH, never off a Will). Forwarding
  // it would emit an alias the receiving client never negotiated ([MQTT-3.1.2-26/27])
  // or one that disagrees with the broker's own table (misdelivery / alias hijack
  // across clients). So a caller alias is always stripped, and the broker applies its
  // own aliasing on top. This applies to EVERY caller alias, whatever the topic
  // shape — a non-empty string, a Buffer (client.publish() skips topic validation),
  // or an empty string. Scrubbing a Buffer/non-empty topic yields a valid full-topic
  // packet; scrubbing the degenerate empty-topic form (an embedder calling the
  // internal publish with `{ topic: '', topicAlias: n }`) yields an unsendable
  // zero-length-topic frame — but that input is malformed either way, and dropping
  // the unnegotiated alias [MQTT-3.1.2-27] is strictly better than emitting it.
  const callerAlias = version === 5 && packet.cmd === 'publish' &&
    packet.properties?.topicAlias !== undefined

  const max = client._outboundTopicAliasMaximum
  // Only alias non-empty *string* topics: a Buffer topic (reachable via
  // client.publish(), which skips topic validation) would key the Map by object
  // identity, so an equal-but-distinct Buffer never matches — burning a fresh
  // alias slot per publish until the table is permanently full.
  if (!max || version !== 5 || packet.cmd !== 'publish' || typeof packet.topic !== 'string' || packet.topic === '') {
    // Aliasing off / not applicable: pass through, but scrub a stray caller alias so
    // the broker never emits an alias the client didn't ask for.
    return callerAlias ? stripTopicAlias(packet) : packet
  }
  const aliases = client._outboundTopicAliases
  const known = aliases.get(packet.topic)
  if (known !== undefined) {
    // Registered topic: send an empty topic + the alias (overwrites any caller alias).
    return { ...packet, topic: '', properties: { ...packet.properties, topicAlias: known } }
  }
  if (aliases.size >= max) {
    // Alias table full: this is a new distinct topic (a known one returned above),
    // so send the full topic name, no alias (never evict). Emit a one-shot telemetry
    // event the first time the table saturates for this connection — otherwise the
    // broker silently degrades to full-topic PUBLISHes with no signal, the case the
    // sessionLimitReached / rejectPacketTooLarge convention exists for. Latched on
    // the client so it fires once per connection, not per PUBLISH.
    if (!client._outboundTopicAliasExhausted) {
      client._outboundTopicAliasExhausted = true
      client.broker.emit('outboundTopicAliasExhausted', client, { max })
    }
    // Scrub a stray caller alias.
    return callerAlias ? stripTopicAlias(packet) : packet
  }
  // New topic: assign the next alias (1..max) and send the full topic + alias,
  // which registers the mapping on the client for subsequent PUBLISHes.
  //
  // The mapping is committed before writeToStream runs (see write() below). Safe
  // today: on a bad packet mqtt.writeToStream does NOT throw — it calls
  // stream.destroy(err) and returns false — and that destroy re-emits via
  // conn.on('error') into _onError, which discards this per-connection map, so no
  // later aliased send references an alias the client never saw. It would stop being
  // safe if a write path ever *drops* a PUBLISH without tearing the connection down
  // (e.g. the planned outbound maximumPacketSize enforcement, whose `false` currently
  // lands in write()'s backpressure branch) — commit only after a successful write if
  // that lands. [#840]
  const alias = aliases.size + 1
  aliases.set(packet.topic, alias)
  return { ...packet, properties: { ...packet.properties, topicAlias: alias } }
}

function write (client, packet, done, protocolVersion) {
  let error = null
  if (client.connecting || client.connected) {
    try {
      // Serialize using the negotiated protocol version so that MQTT v5 reason
      // codes and properties are emitted. The version can be passed explicitly
      // (e.g. a rejection CONNACK before client.version is assigned); otherwise
      // use the version cached at CONNECT (client._wireVersion). Unknown/
      // unsupported versions default to v4 since mqtt-packet only serializes
      // v3/v4/v5.
      let version = client._wireVersion ?? 4
      if (protocolVersion !== undefined) {
        version = (protocolVersion === 3 || protocolVersion === 5) ? protocolVersion : 4
      }
      const toWrite = withOutboundTopicAlias(client, packet, version)
      const result = mqtt.writeToStream(toWrite, client.conn, WRITE_OPTS[version])
      if (!result && !client.errored) {
        // Socket buffer is full - wait for drain
        client.waitForDrain(done)
        return
      }
    } catch (e) {
      // Preserve the underlying cause so v5 DISCONNECT-with-properties encoding
      // failures (and the like) remain diagnosable.
      error = new Error('packet received not valid', { cause: e })
    }
  } else {
    error = new Error('connection closed')
  }

  setImmediate(done, error, client)
}

export default write
