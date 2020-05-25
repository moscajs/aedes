'use strict'

const mqtt = require('mqtt-packet')

function write (client, packet, done) {
  if (client.conn.writable && (client.connecting || client.connected)) {
    try {
      const result = mqtt.writeToStream(packet, client.conn)
      if (!result && !client.errored && done) {
        client.conn.once('drain', done)
        return
      }
      if (done) {
        setImmediate(done)
      }
    } catch (err) {
      setImmediate(client._onError.bind(client, new Error('packet received not valid')))
    }
  } else {
    setImmediate(client._onError.bind(client, new Error('connection closed')))
  }
}

module.exports = write
