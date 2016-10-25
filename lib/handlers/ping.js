'use strict'
var write = require('../write')

function handlePing (client, packet, done) {
  client.broker.emit('ping', packet, client)
  write(client, {
    cmd: 'pingresp'
  }, done)
  done()
}

module.exports = handlePing
