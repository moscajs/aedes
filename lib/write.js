import mqtt from 'mqtt-packet'

// Frozen, module-level writeToStream options per wire version, indexed by the
// resolved version. Avoids allocating a fresh `{ protocolVersion }` object on
// every write — this is the broker's universal (v3/v4 included) hot path.
// `properties: undefined` is declared so these share ONE object shape with the
// per-call `{ ...WRITE_OPTS[v], ...extraOpts }` an AUTH/CONNACK builds — keeping
// writeToStream's `opts.properties` inline cache monomorphic. (Safe: mqtt-packet
// reads opts.properties truthily.)
const WRITE_OPTS = {
  3: Object.freeze({ protocolVersion: 3, properties: undefined }),
  4: Object.freeze({ protocolVersion: 4, properties: undefined }),
  5: Object.freeze({ protocolVersion: 5, properties: undefined })
}

function write (client, packet, done, protocolVersion, extraOpts) {
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
      // `extraOpts` merges per-call writeToStream options (e.g. a Maximum Packet
      // Size so mqtt-packet drops optional props to fit). Only allocated when a
      // caller needs it — the hot path keeps the frozen shared opts object.
      const opts = extraOpts ? { ...WRITE_OPTS[version], ...extraOpts } : WRITE_OPTS[version]
      const result = mqtt.writeToStream(packet, client.conn, opts)
      if (!result && !client.errored) {
        // mqtt-packet's auth() writer returns false when it wrote NOTHING — either
        // the packet can't fit the client's Maximum Packet Size, or getProperties
        // rejected a malformed hook property — never on backpressure (it returns
        // true after writing). Treat that as a send failure [MQTT-3.1.2-25], not a
        // drain wait, which would hang the exchange until connectTimeout. Every other
        // packet's false is genuine backpressure.
        /* c8 ignore next 2 -- defensive: auth.js's fitAuthPacket pre-sizes the AUTH and validAuthResult validates its properties, so auth() returning false is not reachable here today */
        if (packet.cmd === 'auth') {
          error = new Error('AUTH could not be serialized (exceeds the client Maximum Packet Size, or has an invalid property)')
        } else {
          // Socket buffer is full - wait for drain
          client.waitForDrain(done)
          return
        }
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
