#! /usr/bin/env node

const mqtt = require('mqtt')
const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, keepalive: 0 })
const interval = 5000

let sent = 0

function count () {
  console.log('sent/s', sent / interval * 1000)
  sent = 0
}

setInterval(count, interval)

function immediatePublish () {
  setImmediate(publish)
}

function publish () {
  sent++
  client.publish('test', 'payload', immediatePublish)
}

client.on('connect', publish)

client.on('offline', function () {
  console.log('offline')
})

client.on('error', function () {
  console.log('reconnect!')
  client.stream.end()
})
