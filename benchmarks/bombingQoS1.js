#! /usr/bin/env node

const mqtt = require('mqtt')
const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, keepalive: 0 })
const interval = 5000

let sent = 0

function count () {
  if (process.send) {
    const rate = Math.floor(sent / interval * 1000)
    process.send({ type: 'rate', data: rate })
  } else {
    console.log('sent/s', sent / interval * 1000)
  }
}

setInterval(count, interval)

function publish () {
  sent++
  client.publish('test', 'payload', { qos: 1 }, publish)
}

client.setMaxListeners(100)

client.on('connect', function () {
  for (let i = 0; i < 50; i++) {
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
