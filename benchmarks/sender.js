#! /usr/bin/env node

import mqtt from 'mqtt'
import { parseArgs } from 'node:util'
const interval = 5000

let sent = 0
let serial = 0n

const { values } = parseArgs({
  options: {
    qos: {
      type: 'string',
      default: '0',
      choices: ['0', '1'],
      description: 'QoS level to use for publishing messages',
      short: 'q'
    },
    help: {
      type: 'boolean',
      default: false,
      description: 'Show this help message',
      short: 'h'
    }
  }
})

if (values.help) {
  console.log('Usage: node sender.js [options]')
  console.log('Options:')
  console.log('  -q, --qos <0|1>       QoS level to use for publishing messages (default: 0)')
  console.log('  -h, --help            Show this help message')
  process.exit(0)
}

if (!process.send) {
  console.error(`Starting sender with options: qos=${values.qos}`)
}
const publishOpts = {
  qos: parseInt(values.qos, 10),
  retain: false,
  dup: false
}

const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, keepalive: 0 })

function count () {
  if (process.send) {
    const rate = Math.floor(sent / interval * 1000)
    process.send({ type: 'rate', data: rate })
  } else {
    console.log('sent/s', sent / interval * 1000)
  }
  sent = 0
}

setInterval(count, interval)

function immediatePublish () {
  setImmediate(publish)
}

function publish () {
  sent++
  serial++
  const payload = serial.toString()

  client.publish('test', payload, publishOpts, immediatePublish)
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
