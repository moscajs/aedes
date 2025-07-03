#! /usr/bin/env node

const mqtt = require('mqtt')

const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, encoding: 'binary', keepalive: 0 })
const interval = 5000

let counter = 0

function count () {
  if (process.send) {
    const rate = Math.floor(counter / interval * 1000)
    process.send({ type: 'rate', data: rate })
  } else {
    console.log('received/s', counter / interval * 1000)
  }
  counter = 0
}

setInterval(count, interval)

client.on('connect', function () {
  count()
  this.subscribe('test')
  this.on('message', function () {
    counter++
  })
})
