'use strict'

var mqtt = require('mqtt-packet')

function write (client, packet, done) {
  client.conn.write(mqtt.generate(packet), 'binary', done)
}

module.exports = write
