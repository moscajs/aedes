'use strict'

var mqtt = require('mqtt-packet')

function write (client, packet, done) {
  if (client.conn.writable && client.connected) {
    var result = mqtt.writeToStream(packet, client.conn)
    if (!result && !client.errored && done) {
      console.log('drain')
      client.conn.once('drain', done)
      return
    }
    if (done) {
      setImmediate(done)
    }
  } else {
    console.log('error')
    client._onError(new Error('connection closed'))
  }
}

module.exports = write
