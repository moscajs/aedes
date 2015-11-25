'use strict'

var aedes = require('./aedes')()
var server = require('net').createServer(aedes.handle)
var port = 1883

server.listen(port, function () {
  console.log('server listening on port', port)
})

aedes.on('clientError', function (client, err) {
  console.log('client error', client.id, err.message)
})

aedes.on('publish', function (packet, client) {
  if (client) {
    console.log('client', client.id)
  }
})
