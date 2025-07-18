import duplexify from 'duplexify'
import mqtt from 'mqtt-connection'
import { through } from '../lib/utils.js'
import util from 'util'

const parseStream = mqtt.parseStream
const generateStream = mqtt.generateStream
let clients = 0

export function setup (broker) {
  const inStream = generateStream()
  const outStream = parseStream()
  const conn = duplexify(outStream, inStream)

  return {
    client: broker.handle(conn),
    conn,
    inStream,
    outStream,
    broker
  }
}

export function connect (s, opts, connected) {
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

export function noError (s, t) {
  s.broker.on('clientError', function (client, err) {
    if (err) throw err
    t.notOk(err, 'must not error')
  })

  return s
}

export function subscribe (t, subscriber, topic, qos, done) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic,
      qos
    }]
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.same(packet.granted, [qos])
    t.equal(packet.messageId, 24)

    if (done) {
      done(null, packet)
    }
  })
}

// subs: [{topic:, qos:}]
export function subscribeMultiple (t, subscriber, subs, expectedGranted, done) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: subs
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.same(packet.granted, expectedGranted)
    t.equal(packet.messageId, 24)

    if (done) {
      done(null, packet)
    }
  })
}

export const delay = util.promisify(setTimeout)
