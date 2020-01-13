'use strict'

var write = require('../write')
var pingResp = {
  cmd: 'pingresp'
}

function handlePing (client, packet, done) {
  client.broker.emit('ping', packet, client)
  write(client, pingResp, done)
}

module.exports = handlePing
