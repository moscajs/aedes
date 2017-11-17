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

module.exports = {
  aedesPersistenceRedis: aedesPersistenceRedis,
  mqemitterRedis: mqemitterRedis
}
