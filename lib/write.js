import mqtt from 'mqtt-packet'

// Frozen, module-level writeToStream options per wire version, indexed by the
// resolved version. Avoids allocating a fresh `{ protocolVersion }` object on
// every write — this is the broker's universal (v3/v4 included) hot path.
const WRITE_OPTS = {
  3: Object.freeze({ protocolVersion: 3 }),
  4: Object.freeze({ protocolVersion: 4 }),
  5: Object.freeze({ protocolVersion: 5 })
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
      const result = mqtt.writeToStream(packet, client.conn, WRITE_OPTS[version])
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
