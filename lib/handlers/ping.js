'use strict'

var write = require('../write')
var pingResp = {
  cmd: 'pingresp'
}

function handlePing (client, packet, done) {
  write(client, pingResp, function () {
    client.broker.emit('ping', packet, client)
    done()
  })
}

module.exports = handlePing
