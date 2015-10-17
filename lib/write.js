'use strict'

var mqtt = require('mqtt-packet')

function write (client, packet, done) {
  client.conn.cork()
  process.nextTick(uncork, client.conn)

  var result = mqtt.writeToStream(packet, client.conn)

  if (!result && !client.errored && done) {
    client.conn.once('drain', done)
  } else if (done) {
    setImmediate(done)
  }
}

function uncork (stream) {
  stream.uncork()
}

module.exports = write
