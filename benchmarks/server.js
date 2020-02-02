'use strict'

// To be used with cpuprofilify http://npm.im/cpuprofilify

const aedes = require('../')()
const server = require('net').createServer(aedes.handle)
const port = 1883

server.listen(port, function () {
  console.error('server listening on port', port, 'pid', process.pid)
})

aedes.on('clientError', function (client, err) {
  console.error('client error', client.id, err.message)
})

// Cleanly shut down process on SIGTERM to ensure that perf-<pid>.map gets flushed
process.on('SIGINT', onSIGINT)

function onSIGINT () {
  // IMPORTANT to log on stderr, to not clutter stdout which is purely for data, i.e. dtrace stacks
  console.error('Caught SIGTERM, shutting down.')
  server.close()
  process.exit(0)
}
