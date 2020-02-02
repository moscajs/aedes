'use strict'

const mqtt = require('mqtt-packet')

function write (client, packet, done) {
  if (client.conn.writable && client.connected) {
    const result = mqtt.writeToStream(packet, client.conn)
    if (!result && !client.errored && done) {
      client.conn.once('drain', done)
      return
    }
    if (done) {
      setImmediate(done)
    }
  } else {
    setImmediate(client._onError.bind(client, new Error('connection closed')))
  }
}

module.exports = write
