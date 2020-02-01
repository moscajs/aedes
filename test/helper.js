'use strict'

var duplexify = require('duplexify')
var mqtt = require('mqtt-connection')
var through = require('through2')
var util = require('util')
var aedes = require('../')

var parseStream = mqtt.parseStream
var generateStream = mqtt.generateStream
var clients = 0

function setup (broker, autoClose) {
  var inStream = generateStream()
  var outStream = parseStream()
  var conn = duplexify(outStream, inStream)

  broker = broker || aedes()

  broker.handle(conn)

  if (autoClose === undefined || autoClose) {
    setTimeout(function () {
      broker.close()
    }, autoClose || 250)
  }

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
    } else if (connected) {
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
