'use strict'

const duplexify = require('duplexify')
const mqtt = require('mqtt-connection')
const { through } = require('../lib/utils')
const util = require('util')
const aedes = require('../')

const parseStream = mqtt.parseStream
const generateStream = mqtt.generateStream
var clients = 0

function setup (broker) {
  const inStream = generateStream()
  const outStream = parseStream()
  const conn = duplexify(outStream, inStream)

  broker = broker || aedes()

  return {
    client: broker.handle(conn),
    conn: conn,
    inStream: inStream,
    outStream: outStream,
    broker: broker
  }
}

function connect (s, opts, connected) {
  s = Object.create(s)
  s.outStream = s.outStream.pipe(through(filter))

  opts = opts || {}

  opts.cmd = 'connect'
  opts.protocolId = opts.protocolId || 'MQTT'
  opts.protocolVersion = opts.protocolVersion || 4
  opts.clean = !!opts.clean
  opts.clientId = opts.clientId || 'my-client-' + clients++
  opts.keepalive = opts.keepalive || 0

  s.inStream.write(opts)

  return s

  function filter (packet, enc, cb) {
    if (packet.cmd !== 'publish') {
      delete packet.topic
      delete packet.payload
    }

    // using setImmediate to wait for connected to be fired
    // setup also needs to return first
    if (packet.cmd !== 'connack') {
      setImmediate(this.push.bind(this, packet))
    } else if (connected && packet.returnCode === 0) {
      setImmediate(connected, packet)
    }
    cb()
  }
}

function noError (s, t) {
  s.broker.on('clientError', function (client, err) {
    if (err) throw err
    t.notOk(err, 'must not error')
  })

  return s
}

function subscribe (t, subscriber, topic, qos, done) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: topic,
      qos: qos
    }]
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [qos])
    t.equal(packet.messageId, 24)

    if (done) {
      done(null, packet)
    }
  })
}

// subs: [{topic:, qos:}]
function subscribeMultiple (t, subscriber, subs, expectedGranted, done) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: subs
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, expectedGranted)
    t.equal(packet.messageId, 24)

    if (done) {
      done(null, packet)
    }
  })
}

module.exports = {
  setup: setup,
  connect: connect,
  noError: noError,
  subscribe: subscribe,
  subscribeMultiple: subscribeMultiple,
  delay: util.promisify(setTimeout)
}
