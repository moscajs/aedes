import { setTimeout as delay } from 'node:timers/promises'
import { duplexPair, Transform } from 'node:stream'
import mqtt from 'mqtt-packet'
import { Aedes } from '../aedes.js'

let clients = 0

export function setup (broker) {
  const [client, server] = duplexPair()
  const inStream = new Transform(
    {
      objectMode: true,
      transform (chunk, enc, callback) {
        this.push(mqtt.generate(chunk))
        callback()
      }
    })
  inStream.pipe(client)
  const outStream = packetGenerator(mqtt.parser(), client)

  const serverClosed = () => {
    client.destroy()
  }

  const clientClosed = () => {
    server.destroy()
  }

  server.on('close', serverClosed)
  server.on('end', serverClosed)
  client.on('close', clientClosed)
  client.on('end', clientClosed)

  return {
    client: broker.handle(server),
    conn: client,
    outStream,
    inStream,
    broker
  }
}

/**
 * Establishes an MQTT connection with the specified options
 * @param {Object} s - The connection state object
 * @param {Object} opts - MQTT connection options
 * @returns {Object} the connack packet
 */

export async function connect (s, opts = {}) {
  const connect = opts.connect || {}
  connect.cmd = 'connect'
  connect.protocolId = connect.protocolId || 'MQTT'
  connect.protocolVersion = connect.protocolVersion || 4
  connect.clean = connect.clean !== false
  connect.clientId = connect.clientId || 'my-client'
  connect.username = connect.username || 'my username'
  connect.password = connect.password || 'my pass'
  connect.keepalive = connect.keepalive || 0
  const expectedReturnCode = opts.expectedReturnCode || 0
  const verifyReturnedOk = opts.verifyReturnedOk !== false
  if (opts.autoClientId) {
    connect.clientId = 'my-client-' + clients++
  }
  if (opts.noCredentials) {
    connect.username = undefined
    connect.password = undefined
  }

  if (opts.noClientId) {
    connect.clientId = undefined
  }

  s.inStream.write(connect)
  const { value: connack } = await s.outStream.next()
  if (connack.cmd !== 'connack') {
    throw new Error('Expected connack')
  }
  if (verifyReturnedOk && (connack.returnCode !== expectedReturnCode)) {
    throw new Error(`Expected connack return code ${expectedReturnCode} but received ${connack.returnCode}`)
  }
  return connack
}

/**
 * Creates a new MQTT connection and establishes it
 * @param {Object} t - Test assertion object
 * @returns {Object} Connection state
 */
export async function createAndConnect (t, opts = {}) {
  const broker = await Aedes.createBroker(opts.broker)
  t.after(() => broker.close())
  const s = setup(broker)
  await connect(s, opts)
  return s
}

/**
 * Sets up error handling for the broker connection
 * @param {Object} s - The connection state object
 * @param {Object} t - Test assertion object
 * @returns {Object} Connection state with error handling
 */
export function noError (s, t) {
  s.broker.on('clientError', function (client, err) {
    if (err) throw err
    t.assert.equal(err, undefined, 'must not error')
  })
  return s
}

/**
 * @param {Object} s      - The connection state object
 * @param {Object} packet - The packet to publish
 * @returns {Promise}     - Promise that resolves when the packet is published
 */
export async function brokerPublish (s, packet) {
  return new Promise((resolve) => {
    s.broker.publish(packet, () => {
      setImmediate(resolve)
    })
  })
}

/**
 * Subscribes to a single MQTT topic
 * @param {Object} t - Test assertion object
 * @param {Object} subscriber - The subscriber client
 * @param {string} topic - Topic to subscribe to
 * @param {number} qos - Quality of Service level
 */
export async function subscribe (t, subscriber, topic, qos) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic,
      qos
    }]
  })

  const { value: packet } = await subscriber.outStream.next()
  t.assert.equal(packet.cmd, 'suback')
  t.assert.equal(packet.granted[0], qos)
  t.assert.equal(packet.messageId, 24)
  return packet
}

/**
 * Subscribes to multiple MQTT topics
 * @param {Object} t - Test assertion object
 * @param {Object} subscriber - The subscriber client
 * @param {Array<Object>} subs - Array of subscription objects with topic and qos
 * @param {Array<number>} expectedGranted - Expected QoS levels granted
 */
export async function subscribeMultiple (t, subscriber, subs, expectedGranted) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: subs
  })

  const { value: packet } = await subscriber.outStream.next()
  t.assert.equal(packet.cmd, 'suback')
  t.assert.deepEqual(packet.granted, expectedGranted)
  t.assert.equal(packet.messageId, 24)
  return packet
}

/**
 * Wraps a promise with a timeout
 * @param {Promise} promise - Promise to wrap with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {Error} err - Error to throw on timeout
 * @returns {Promise} Promise that rejects if timeout occurs
 */
export async function withTimeout (promise, timeoutMs, timeoutResult) {
  const timeoutPromise = delay(timeoutMs, timeoutResult, { ref: false })
  return Promise.race([promise, timeoutPromise])
}

/**
 * @param {Object} parser - The emitter object
 * @param {Readable} sourceStream - The source stream to read MQTT packets from
 * @param {Object} opts - low and high water mark
 * @returns {AsyncGenerator} An async generator that yields MQTT packets
 */
async function * packetGenerator (parser, sourceStream, opts = {
  highWaterMark: 2,
  lowWaterMark: 0
}) {
  const { highWaterMark, lowWaterMark } = opts
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1) {
    throw new Error('highWaterMark must be a positive integer')
  }
  if (!Number.isInteger(lowWaterMark) || lowWaterMark < 0) {
    throw new Error('lowWaterMark must be a non-negative integer')
  }
  if (lowWaterMark >= highWaterMark) {
    throw new Error('lowWaterMark must be less than or equal to highWaterMark')
  }
  const queue = []
  let waiting = null
  const done = null

  const onPacket = packet => {
    if (waiting) {
      waiting(packet)
      waiting = null
    } else {
      queue.push(packet)
    }
    // Pause source if queue is full
    if (queue.length > highWaterMark) {
      sourceStream.pause()
    }
  }

  parser.on('packet', onPacket)
  sourceStream.on('data', parser.parse.bind(parser))
  const endGeneration = (value) => {
    if (waiting) {
      waiting(value)
      waiting = null
    }
    if (value) {
      queue.push(value)
    }
  }
  sourceStream.on('error', (err) => endGeneration(err))
  sourceStream.on('end', () => endGeneration(null))
  sourceStream.on('close', () => endGeneration(null))

  try {
    while (true) {
      if (done) {
        yield null
      } else {
        if (queue.length === 0) {
          // Wait for next packet
          const packet = await new Promise(resolve => (waiting = resolve))
          yield packet
        } else {
          // There is buffered data ready
          // If we're emptying the queue, resume source
          if (queue.length <= lowWaterMark) {
            sourceStream.resume()
          }
          yield queue.shift()
        }
      }
    }
  } finally {
    sourceStream.pause()
    parser.off('packet', onPacket)
  }
}

export async function nextPacket (s) {
  const { value: packet } = await s.outStream.next()
  return packet
}

export async function nextPacketWithTimeOut (s, timeoutMs) {
  return withTimeout(nextPacket(s), timeoutMs, null)
}

export { delay }
