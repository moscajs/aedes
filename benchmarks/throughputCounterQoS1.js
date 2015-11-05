#! /usr/bin/env node

var mqtt = require('mqtt')

var client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, encoding: 'binary', keepalive: 0 })
var counter = 0
var interval = 5000

function count () {
  console.log('received/s', counter / interval * 1000)
  counter = 0
}

setInterval(count, interval)

client.on('connect', function () {
  this.subscribe('test', { qos: 1 })
})

client.handleMessage = function (packet, done) {
  counter++
  done()
}

client.on('offline', function () {
  console.log('offline')
})

client.on('error', function () {
  console.log('reconnect!')
  client.stream.end()
})
