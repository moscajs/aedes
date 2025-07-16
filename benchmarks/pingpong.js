#! /usr/bin/env node
import { parseArgs } from 'node:util'
import { hrtime } from 'node:process'
import mqtt from 'mqtt'
const interval = 5000

function processsLatencies (latencies, counter) {
  let total = 0
  let count = 0
  let median
  let perc95
  let perc99
  const posMedian = Math.floor(counter / 2)
  const pos95 = Math.floor(counter * 0.95)
  const pos99 = Math.floor(counter * 0.99)
  // sort keys from smallest to largest
  const keys = Object.keys(latencies).sort((a, b) => a - b)
  for (const key of keys) {
    const value = latencies[key]
    total += value * key
    count += value

    if (count >= posMedian && median === undefined) {
      median = key
    }
    if (count >= pos95 && perc95 === undefined) {
      perc95 = key
    }
    if (count >= pos99 && perc99 === undefined) {
      perc99 = key
    }
  }
  return {
    buckets: keys.length,
    mean: Math.floor(total / counter),
    minimum: keys[0],
    maximum: keys.pop(),
    median,
    perc95,
    perc99,
  }
}

let counter = 0
let latencies = {}

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
  console.log('Usage: node pingpong.js [options]')
  console.log('Options:')
  console.log('  -q, --qos <0|1>       QoS level to use for publishing messages (default: 0)')
  console.log('  -h, --help            Show this help message')
  process.exit(0)
}

if (!process.send) {
  console.error(`Starting pingpong with options: qos=${values.qos}`)
}
const client = mqtt.connect({ port: 1883, host: 'localhost', clean: true, encoding: 'binary', keepalive: 0 })

const qosOpts = {
  qos: parseInt(values.qos, 10),
}

function count () {
  // reset latencies while keeping the counts

  const latencyResult = processsLatencies(latencies, counter)
  latencies = {}
  if (process.send) {
    process.send({ type: 'latency', data: latencyResult })
  } else {
    console.log('latencies', latencyResult)
  }
  counter = 0
}

setInterval(count, interval)

function publish () {
  counter++
  client.publish('test', process.hrtime.bigint().toString(), qosOpts)
}

function subscribe () {
  client.subscribe('test', qosOpts, publish)
}

client.on('connect', subscribe)
client.on('message', publish)
client.on('message', function (topic, payload) {
  const receivedAt = hrtime.bigint()
  const sentAt = BigInt(payload.toString())
  const msDiff = Math.floor(Number(receivedAt - sentAt) / 1e6) // Convert from nanoseconds to milliseconds
  latencies[msDiff] = (latencies[msDiff] || 0) + 1
})

client.on('offline', function () {
  console.log('offline')
})

client.on('error', function () {
  console.log('reconnect!')
  client.stream.end()
})
