#! /usr/bin/env node
const { parseArgs } = require('node:util')
const mqtt = require('mqtt')

const interval = 5000

let counter = 0
let previousSerial

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
  console.log('Usage: node receiver.js [options]')
  console.log('Options:')
  console.log('  -q, --qos <0|1>       QoS level to use for publishing messages (default: 0)')
  console.log('  -h, --help            Show this help message')
  process.exit(0)
}

const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, encoding: 'binary', keepalive: 0 })

if (!process.send) {
  console.error(`Starting receiver with options: qos=${values.qos}`)
}
const subscribeOpts = {
  qos: parseInt(values.qos, 10),
}

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
  this.subscribe('test', subscribeOpts)
})

client.handleMessage = function (packet, done) {
  const serial = BigInt(packet.payload.toString())
  if (previousSerial !== undefined && (serial !== (previousSerial + 1n))) {
    console.error(`Received out of order message: expected ${previousSerial}, got ${serial}`)
  }
  previousSerial = serial
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
