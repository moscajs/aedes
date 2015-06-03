'use strict'

var mqtt = require('mqtt-connection')
var through = require('through2')
var aedes = require('../')
var duplexify = require('duplexify')
var parseStream = mqtt.parseStream
var generateStream = mqtt.generateStream
var clients = 0

function setup (broker) {
  var inStream = generateStream()
  var outStream = parseStream()
  var conn = duplexify(outStream, inStream)

  broker = broker || aedes()

  broker.handle(conn)

  return {
    conn: conn,
    inStream: inStream,
    outStream: outStream,
    broker: broker
  }
}

function connect (s, opts, connected) {
  s = Object.create(s)
  s.outStream = s.outStream.pipe(through.obj(filter))

  opts = opts || {}

  opts.cmd = 'connect'
  opts.protocolId = 'MQTT'
  opts.version = 4
  opts.clean = !!opts.clean
  opts.clientId = opts.clientId || 'my-client-' + clients++
  opts.keepalive = opts.keepAlive || 0

  s.inStream.write(opts)

  return s

  function filter (packet, enc, cb) {
    if (packet.cmd !== 'publish') {
      delete packet.topic
      delete packet.payload
    }
    if (packet.cmd !== 'connack') {
      this.push(packet)
    } else if (connected) {
      connected(packet)
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
    done(null, packet)
  })
}

module.exports = {
  setup: setup,
  connect: connect,
  noError: noError,
  subscribe: subscribe
}
