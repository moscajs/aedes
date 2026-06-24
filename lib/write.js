import mqtt from 'mqtt-packet'

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
      const result = mqtt.writeToStream(packet, client.conn, { protocolVersion: version })
      if (!result && !client.errored) {
        // Socket buffer is full - wait for drain
        client.waitForDrain(done)
        return
      }
    } catch (e) {
      error = new Error('packet received not valid')
    }
  } else {
    error = new Error('connection closed')
  }

  setImmediate(done, error, client)
}

export default write
