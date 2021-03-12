#! /usr/bin/env node

const mqtt = require('mqtt')
const convertHrtime = require('convert-hrtime')
const mode = require('compute-mode')
const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, keepalive: 0 })
const interval = 5000

let sent = 0
const latencies = []

function count () {
  console.log('sent/s', sent / interval * 1000)
  sent = 0
}

setInterval(count, interval)

function publish () {
  sent++
  client.publish('test', JSON.stringify(process.hrtime()), { qos: 1 })
}

function subscribe () {
  client.subscribe('test', { qos: 1 }, publish)
}

client.on('connect', subscribe)
client.on('message', publish)
client.on('message', function (topic, payload) {
  const sentAt = JSON.parse(payload)
  const diff = process.hrtime(sentAt)
  latencies.push(convertHrtime(diff).ms)
})

client.on('offline', function () {
  console.log('offline')
})

client.on('error', function () {
  console.log('reconnect!')
  client.stream.end()
})

process.on('SIGINT', function () {
  const total = latencies.reduce(function (acc, num) {
    return acc + num
  })
  console.log('total', total)
  console.log('average', total / latencies.length)
  console.log('mode', mode(latencies))
  process.exit(0)
})
