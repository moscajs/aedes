'use strict'

// To be used with cpuprofilify http://npm.im/cpuprofilify
var aedesPersistenceRedis = require('aedes-persistence-redis')({
  port: 6379,          // Redis port
  host: '127.0.0.1',   // Redis host
  family: 4,           // 4 (IPv4) or 6 (IPv6)
  password: 'auth',
  db: 0,
  maxSessionDelivery: 100 // maximum offline messages deliverable on client CONNECT, default is 1000
})
var mqemitterRedis = require('mqemitter-redis')({
  port: 6379,          // Redis port
  host: '127.0.0.1',   // Redis host
  family: 4,           // 4 (IPv4) or 6 (IPv6)
  password: 'auth',
  db: 0,
  maxSessionDelivery: 100 // maximum offline messages deliverable on client CONNECT, default is 1000
})

var aedes = require('../')({persistence: aedesPersistenceRedis, mq: mqemitterRedis})
var server = require('net').createServer(aedes.handle)
var port = 1883

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
