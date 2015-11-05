#! /usr/bin/env node

var mqtt = require('mqtt')
var client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, keepalive: 0 })

var sent = 0
var interval = 5000

function count () {
  console.log('sent/s', sent / interval * 1000)
  sent = 0
}

setInterval(count, interval)

function publish () {
  sent++
  client.publish('test', 'payload', { qos: 1 }, publish)
}

client.setMaxListeners(100)

client.on('connect', function () {
  for (var i = 0; i < 50; i++) {
    publish()
  }
})

client.on('offline', function () {
  console.log('offline')
})

client.on('error', function () {
  console.log('reconnect!')
  client.stream.end()
})
