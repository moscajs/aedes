'use strict'

const mqtt = require('mqtt-packet')

function write (client, packet, done) {
  let error = null
  if (client.connecting || client.connected) {
    try {
      const result = mqtt.writeToStream(packet, client.conn)
      if (!result && !client.errored) {
        client.conn.once('drain', done)
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

module.exports = write
