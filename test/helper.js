import { setTimeout as delay } from 'node:timers/promises'
import { duplexPair, Transform } from 'node:stream'
import { platform } from 'node:os'
import mqtt from 'mqtt-packet'
import { Aedes } from '../aedes.js'

let clients = 0

/**
 * Check if tests should be skipped on Windows and macOS platforms
 * These platforms often lack proper support for certain network features
 * like socket.readStop() or have issues with Docker/Testcontainers
 * @returns {boolean} true if tests should be skipped on this platform
 */
export function shouldSkipOnWindowsAndMac () {
  const os = platform()
  return os === 'win32' || os === 'darwin'
}

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
  const verifyIsConnack = opts.verifyIsConnack !== false
  const verifyReturnedOk = verifyIsConnack ? opts.verifyReturnedOk !== false : false
  const noWait = opts.noWait

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
  if (noWait) {
    return
  }
  const { value: connack } = await s.outStream.next()
  if (verifyIsConnack && connack?.cmd !== 'connack') {
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
 * Creates a new MQTT connection and establishes it for publisher and subscriber
 * @param {Object} t - Test assertion object
 * @returns {Object} Connection state { broker, publisher, subscriber }
 */
export async function createPubSub (t, opts = {}) {
  const publisherOpts = { clientId: 'publisher', ...opts.publisher }
  const subscriberOpts = { clientId: 'subscriber', ...opts.subscriber }

  const broker = await Aedes.createBroker()
  t.after(() => broker.close())

  const publisher = setup(broker)
  const subscriber = setup(broker)
  await connect(publisher, { connect: publisherOpts })
  await connect(subscriber, { connect: subscriberOpts })
  return { broker, publisher, subscriber }
}

/**
 * Sets up error handling for the broker connection
 * @param {Object} s - The connection state object
 * @param {Object} t - Test assertion object
 * @returns {Object} Connection state with error handling
 */
export function noError (s, t) {
  s.broker.on('clientError', (client, err) => {
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
 *  publish a packet to the broker
 * @param {Object} t - Test assertion object
 * @param {Object} s - The connection state object
 * @param {Object} packet - The packet to publish
 * @returns {Promise} - Promise that resolves when the packet is published
 */
export async function publish (t, s, packet) {
  s.inStream.write(packet)
  const msgId = packet.messageId
  if (packet.qos === 1) {
    const { value: puback } = await s.outStream.next()
    t.assert.equal(puback.cmd, 'puback')
    return puback
  }
  if (packet.qos === 2) {
    const { value: pubrec } = await s.outStream.next()
    t.assert.deepStrictEqual(structuredClone(pubrec), {
      cmd: 'pubrec',
      messageId: msgId,
      length: 2,
      dup: false,
      retain: false,
      qos: 0,
      payload: null,
      topic: null
    }, 'pubrec must match')
    s.inStream.write({
      cmd: 'pubrel',
      messageId: pubrec.messageId
    })
    const { value: pubcomp } = await s.outStream.next()
    t.assert.deepEqual(structuredClone(pubcomp), {
      cmd: 'pubcomp',
      messageId: msgId,
      length: 2,
      dup: false,
      retain: false,
      qos: 0,
      payload: null,
      topic: null
    }, 'pubcomp must match')
    return pubcomp
  }
  return null
}
/**
 * Subscribes to a single MQTT topic
 * @param {Object} t - Test assertion object
 * @param {Object} subscriber - The subscriber client
 * @param {string} topic - Topic to subscribe to
 * @param {number} qos - Quality of Service level
 * @param {number} messageId - Message ID for the subscription
 * @returns {Object} The subscription packet
 */
export async function subscribe (t, subscriber, topic, qos, messageId = 24) {
  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId,
    subscriptions: [{
      topic,
      qos
    }]
  })

  const { value: packet } = await subscriber.outStream.next()
  t.assert.equal(packet.cmd, 'suback')
  t.assert.equal(packet.granted[0], qos)
  t.assert.equal(packet.messageId, messageId)
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
  const timeoutPromise = delay(timeoutMs, timeoutResult)
  return Promise.race([promise, timeoutPromise])
}

/**
 * Asynchronously yields MQTT packets parsed from a source stream, with backpressure management.
 *
 * Backpressure is controlled using a queue and the `highWaterMark`/`lowWaterMark` parameters:
 * - When the number of buffered packets in the queue reaches `highWaterMark`, the source stream is paused to prevent overload.
 * - When the queue size drops to or below `lowWaterMark`, the source stream is resumed to allow more data to flow.
 *
 * @param {Object} parser - The emitter object that parses MQTT packets and emits 'packet' events.
 * @param {Readable} sourceStream - The source stream to read MQTT packets from.
 * @param {Object} [opts] - Options for backpressure control.
 * @param {number} [opts.highWaterMark=2] - Maximum number of packets to buffer before pausing the source stream.
 * @param {number} [opts.lowWaterMark=0] - Minimum number of packets in the buffer to resume the source stream.
 * @returns {AsyncGenerator<Object|null, void, unknown>} An async generator that yields MQTT packets, or null when done.
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
    throw new Error('lowWaterMark must be less than highWaterMark')
  }
  const queue = []
  let waiting = null
  let done = false

  const onPacket = packet => {
    if (waiting) {
      waiting(packet)
      waiting = null
    } else {
      queue.push(packet)
    }
    // Pause source if queue is full
    if (queue.length >= highWaterMark) {
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
    done = true
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

/**
 * Reads next packet from subscriber
 * @param {Object} s - The connection state object
 * @returns
 */
export async function nextPacket (s) {
  const { value: packet } = await s.outStream.next()
  return packet
}

/**
 * Reads next packet from subscriber with timeout
 * @param {Object} s - The connection state object
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns
 */
export async function nextPacketWithTimeOut (s, timeoutMs) {
  return withTimeout(nextPacket(s), timeoutMs, null)
}

/**
 * Checks if there is no packet received within the specified timeout
 * @param {Object} t - Test assertion object
 * @param {Object} s - s The connection state object
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns
 */
export async function checkNoPacket (t, s, timeoutMs = 10) {
  const result = await nextPacketWithTimeOut(s, timeoutMs)
  t.assert.equal(result, null, 'no packet received')
}

/**
 *
 * @param {Object} s - s The connection state object
 * @param {string} rawPacket - space separated string of hex values
 * @example rawWrite(s, "10 0C 00 04 4D 51 54 54 04 00 00 00 00 00")
 */
export function rawWrite (s, rawPacket) {
  s.conn.write(Buffer.from(rawPacket.replace(/ /g, ''), 'hex'))
}
/**
 * sleep
 */
export { delay }
