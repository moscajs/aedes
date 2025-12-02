/**
 * Drain Timeout Tests
 *
 * Tests for the drainTimeout feature that protects against slow/frozen clients
 * blocking message delivery to all other subscribers.
 *
 * Includes:
 * - Unit tests with mocked streams (reliable, deterministic)
 * - E2E tests with real TCP using readStop() (proves the fix works)
 *
 * Run: node --test test/drain-timeout.js
 */

import { test } from 'node:test'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import mqtt from 'mqtt'
import { Aedes } from '../aedes.js'

const { duplexPair } = await import('node:stream')
const mqttPacket = await import('mqtt-packet')

// ============================================================================
// UNIT TESTS - Mocked Streams
// ============================================================================

/**
 * Helper: Create a mocked MQTT client connection
 */
function createMockedClient (broker, clientId) {
  const [clientSide, serverSide] = duplexPair()

  // Allow controlling write behavior
  let blockWrites = false
  const originalWrite = serverSide.write.bind(serverSide)

  serverSide.write = function (chunk, encoding, callback) {
    if (blockWrites) {
      // Simulate full buffer - return false and never emit drain
      return false
    }
    return originalWrite(chunk, encoding, callback)
  }

  // Track received packets
  const parser = mqttPacket.parser()
  const receivedPackets = []
  parser.on('packet', (packet) => receivedPackets.push(packet))
  clientSide.on('data', (chunk) => parser.parse(chunk))

  // Track connection state
  let destroyed = false
  serverSide.on('close', () => { destroyed = true })
  serverSide.on('error', () => { destroyed = true })

  broker.handle(serverSide)

  // Send CONNECT
  clientSide.write(mqttPacket.generate({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId,
    keepalive: 0
  }))

  return {
    clientSide,
    serverSide,
    receivedPackets,
    setBlocked: (blocked) => { blockWrites = blocked },
    isDestroyed: () => destroyed,
    subscribe: (topic) => {
      clientSide.write(mqttPacket.generate({
        cmd: 'subscribe',
        messageId: 1,
        subscriptions: [{ topic, qos: 0 }]
      }))
    },
    destroy: () => {
      clientSide.destroy()
      serverSide.destroy()
    }
  }
}

test('UNIT: write.js blocks indefinitely when stream.write returns false', async (t) => {
  // This test verifies the bug behavior WITHOUT the fix.
  // When stream.write() returns false and drain never fires,
  // the broker blocks indefinitely waiting for drain.

  const broker = await Aedes.createBroker({ drainTimeout: 0 }) // No timeout = buggy behavior
  t.after(() => broker.close())

  const client = createMockedClient(broker, 'blocked-client')
  await delay(50)
  client.subscribe('test/#')
  await delay(50)

  // Block writes to simulate full buffer
  client.setBlocked(true)

  // Publish - should block forever
  let publishDone = false
  const publishPromise = new Promise((resolve) => {
    broker.publish(
      { topic: 'test/blocked', payload: Buffer.from('test') },
      () => {
        publishDone = true
        resolve('completed')
      }
    )
  })

  const result = await Promise.race([publishPromise, delay(2000, 'timeout')])

  client.destroy()

  // STRICT ASSERTION: Must timeout to prove the bug
  t.assert.strictEqual(result, 'timeout', 'broker must block when write returns false')
  t.assert.strictEqual(publishDone, false, 'publish callback must not fire')
})

test('UNIT: drainTimeout disconnects slow client instead of blocking', async (t) => {
  // This test verifies that with drainTimeout enabled,
  // the broker disconnects slow clients instead of waiting forever.

  const DRAIN_TIMEOUT_MS = 300
  const broker = await Aedes.createBroker({ drainTimeout: DRAIN_TIMEOUT_MS })
  t.after(() => broker.close())

  const client = createMockedClient(broker, 'drain-fix-test')
  await delay(50)
  client.subscribe('fix/test')
  await delay(50)

  // Verify handshake completed
  const connack = client.receivedPackets.find(p => p.cmd === 'connack')
  const suback = client.receivedPackets.find(p => p.cmd === 'suback')
  t.assert.ok(connack, 'should receive CONNACK')
  t.assert.ok(suback, 'should receive SUBACK')

  // Block writes to simulate backpressure
  client.setBlocked(true)

  // Publish - should complete after drainTimeout kicks the client
  let publishDone = false
  const publishPromise = new Promise((resolve) => {
    broker.publish(
      { topic: 'fix/test', payload: Buffer.alloc(1024, 'X') },
      () => {
        publishDone = true
        resolve('published')
      }
    )
  })

  const result = await Promise.race([
    publishPromise,
    delay(DRAIN_TIMEOUT_MS + 500, 'timeout')
  ])

  client.destroy()

  // STRICT ASSERTIONS: Fix must work
  t.assert.strictEqual(result, 'published', 'publish must complete after drain timeout')
  t.assert.strictEqual(publishDone, true, 'publish callback must fire')
  t.assert.ok(client.isDestroyed(), 'slow client connection must be destroyed')
})

test('UNIT: single slow client with concurrency 1 causes deadlock', async (t) => {
  // With concurrency: 1, one blocked client = complete deadlock
  // This demonstrates why the fix is critical

  const broker = await Aedes.createBroker({ concurrency: 1, drainTimeout: 0 })
  t.after(() => broker.close())

  const fastClient = createMockedClient(broker, 'fast-1')
  const slowClient = createMockedClient(broker, 'slow-1')
  await delay(50)

  fastClient.subscribe('deadlock/#')
  slowClient.subscribe('deadlock/#')
  await delay(50)

  // Block slow client
  slowClient.setBlocked(true)

  // Publish multiple messages
  let publishCount = 0
  const NUM_MESSAGES = 5

  const publishPromise = (async () => {
    for (let i = 0; i < NUM_MESSAGES; i++) {
      await new Promise((resolve) => {
        broker.publish(
          { topic: 'deadlock/test', payload: Buffer.from(`msg-${i}`) },
          () => {
            publishCount++
            resolve()
          }
        )
      })
    }
    return 'done'
  })()

  const result = await Promise.race([publishPromise, delay(3000, 'DEADLOCK')])

  // Count messages fast client received
  const fastReceived = fastClient.receivedPackets.filter(p => p.cmd === 'publish').length

  fastClient.destroy()
  slowClient.destroy()

  // STRICT ASSERTIONS: Must deadlock
  t.assert.strictEqual(result, 'DEADLOCK', 'must deadlock with concurrency 1 and blocked client')
  t.assert.ok(publishCount < NUM_MESSAGES, `only ${publishCount}/${NUM_MESSAGES} publishes should complete`)
  t.assert.ok(fastReceived < NUM_MESSAGES, `fast client received ${fastReceived}/${NUM_MESSAGES} - blocked by slow client`)
})

test('UNIT: drainTimeout allows system to recover from deadlock', async (t) => {
  // With drainTimeout, the slow client gets disconnected and the system recovers

  const DRAIN_TIMEOUT = 200
  const broker = await Aedes.createBroker({ concurrency: 1, drainTimeout: DRAIN_TIMEOUT })
  t.after(() => broker.close())

  const fastClient = createMockedClient(broker, 'recovery-fast')
  const slowClient = createMockedClient(broker, 'recovery-slow')
  await delay(50)

  fastClient.subscribe('recovery/#')
  slowClient.subscribe('recovery/#')
  await delay(50)

  // Block slow client
  slowClient.setBlocked(true)

  // Publish messages - should complete after slow client is kicked
  const NUM_MESSAGES = 5
  let completed = 0
  const startTime = Date.now()

  for (let i = 0; i < NUM_MESSAGES; i++) {
    await new Promise((resolve) => {
      broker.publish(
        { topic: 'recovery/test', payload: Buffer.from(`msg-${i}`) },
        () => {
          completed++
          resolve()
        }
      )
    })
  }

  const elapsed = Date.now() - startTime
  const fastReceived = fastClient.receivedPackets.filter(p => p.cmd === 'publish').length

  fastClient.destroy()
  slowClient.destroy()

  // STRICT ASSERTIONS: Recovery must work
  t.assert.strictEqual(completed, NUM_MESSAGES, 'all publishes must complete after recovery')
  t.assert.ok(slowClient.isDestroyed(), 'slow client must be disconnected')
  t.assert.ok(fastReceived > 0, `fast client received ${fastReceived} messages after recovery`)
  t.assert.ok(elapsed >= DRAIN_TIMEOUT, `should take at least ${DRAIN_TIMEOUT}ms for first timeout`)
})

// ============================================================================
// E2E TESTS - Real TCP with readStop()
// ============================================================================

/**
 * RELIABLE APPROACH: readStop()
 *
 * Calling socket._handle.readStop() stops libuv from reading at the kernel level.
 * This causes TCP receive buffer to fill → TCP flow control → sender's send buffer
 * fills → write() returns false.
 *
 * Other approaches that DON'T reliably work on localhost:
 * - stream.pause() - only pauses Node.js stream, not kernel recv()
 * - Small highWaterMark - can't change after socket construction
 * - Transform wrapper - breaks bidirectional communication
 */

test('E2E: readStop() triggers real TCP backpressure', async (t) => {
  // This test MUST demonstrate backpressure or FAIL
  // It proves that readStop() reliably triggers write() returning false

  const broker = await Aedes.createBroker({ concurrency: 1 })
  const server = createServer(broker.handle)

  let writeReturnedFalse = false
  let backpressureAtMessage = -1

  broker.on('client', (client) => {
    if (client.id === 'e2e-slow') {
      const origWrite = client.conn.write.bind(client.conn)
      client.conn.write = function (...args) {
        const result = origWrite(...args)
        if (result === false && !writeReturnedFalse) {
          writeReturnedFalse = true
        }
        return result
      }
    }
  })

  t.after(async () => {
    broker.close()
    server.close()
  })

  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  // Slow client
  const slowClient = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'e2e-slow'
  })
  await slowClient.subscribeAsync('e2e/#')

  // Stop reading at kernel level - THIS IS THE KEY
  slowClient.stream.pause()
  if (slowClient.stream._handle && slowClient.stream._handle.readStop) {
    slowClient.stream._handle.readStop()
  } else {
    t.skip('readStop() not available on this platform')
    return
  }

  // Publisher
  const publisher = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'e2e-pub'
  })

  const payload = Buffer.alloc(256 * 1024, 'X') // 256KB
  const MAX_MESSAGES = 100
  let sent = 0

  for (let i = 0; i < MAX_MESSAGES; i++) {
    await new Promise(resolve => {
      publisher.publish('e2e/test', payload, { qos: 0 }, () => {
        sent++
        resolve()
      })
    })

    if (writeReturnedFalse) {
      backpressureAtMessage = sent
      break
    }
  }

  slowClient.end(true)
  publisher.end(true)

  // STRICT ASSERTION: This test MUST achieve backpressure
  t.assert.strictEqual(
    writeReturnedFalse,
    true,
    'readStop() must trigger TCP backpressure'
  )
  t.assert.ok(backpressureAtMessage > 0 && backpressureAtMessage < MAX_MESSAGES,
    `Backpressure should occur before sending all ${MAX_MESSAGES} messages`)
})

test('E2E: drainTimeout disconnects slow client after TCP backpressure', async (t) => {
  // This test demonstrates the fix with real TCP:
  // 1. Real backpressure (write() returns false)
  // 2. drainTimeout kicks in and disconnects slow client

  const DRAIN_TIMEOUT = 500 // Short timeout for faster test

  const broker = await Aedes.createBroker({
    concurrency: 1,
    drainTimeout: DRAIN_TIMEOUT
  })
  const server = createServer(broker.handle)

  let writeReturnedFalse = false
  let slowClientDisconnected = false

  broker.on('client', (client) => {
    if (client.id === 'recovery-slow') {
      const origWrite = client.conn.write.bind(client.conn)
      client.conn.write = function (...args) {
        const result = origWrite(...args)
        if (result === false && !writeReturnedFalse) {
          writeReturnedFalse = true
        }
        return result
      }
    }
  })

  broker.on('clientDisconnect', (client) => {
    if (client.id === 'recovery-slow') {
      slowClientDisconnected = true
    }
  })

  t.after(async () => {
    broker.close()
    server.close()
  })

  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  // Slow client
  const slowClient = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'recovery-slow'
  })
  await slowClient.subscribeAsync('recovery/#')

  // Stop reading at kernel level
  slowClient.stream.pause()
  if (slowClient.stream._handle && slowClient.stream._handle.readStop) {
    slowClient.stream._handle.readStop()
  } else {
    t.skip('readStop() not available')
    return
  }

  // Publisher
  const publisher = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'recovery-pub'
  })

  const payload = Buffer.alloc(256 * 1024, 'R')
  const NUM_MESSAGES = 20

  // Publish to trigger backpressure
  for (let i = 0; i < NUM_MESSAGES; i++) {
    publisher.publish('recovery/test', payload, { qos: 0 })
    if (writeReturnedFalse) break
  }

  // Wait for drainTimeout to fire + margin
  await delay(DRAIN_TIMEOUT + 200)

  slowClient.end(true)
  publisher.end(true)

  // STRICT ASSERTIONS
  t.assert.strictEqual(writeReturnedFalse, true,
    'Must trigger backpressure for this test to be valid')
  t.assert.strictEqual(slowClientDisconnected, true,
    'drainTimeout must disconnect slow client')
})

test('E2E: without drainTimeout, slow client impairs system throughput', async (t) => {
  // This test demonstrates the BUG with real TCP:
  // Without drainTimeout, a slow client severely impairs message delivery

  const broker = await Aedes.createBroker({
    concurrency: 1,
    drainTimeout: 0 // Disabled - original buggy behavior
  })
  const server = createServer(broker.handle)

  let writeReturnedFalse = false

  broker.on('client', (client) => {
    if (client.id === 'bug-slow') {
      const origWrite = client.conn.write.bind(client.conn)
      client.conn.write = function (...args) {
        const result = origWrite(...args)
        if (result === false && !writeReturnedFalse) {
          writeReturnedFalse = true
        }
        return result
      }
    }
  })

  t.after(async () => {
    broker.close()
    server.close()
  })

  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  // Slow client
  const slowClient = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'bug-slow'
  })
  await slowClient.subscribeAsync('bug/#')

  // Fast client
  const fastClient = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'bug-fast'
  })
  await fastClient.subscribeAsync('bug/#')

  let fastReceived = 0
  fastClient.on('message', () => { fastReceived++ })

  // Stop slow client from reading
  slowClient.stream.pause()
  if (slowClient.stream._handle && slowClient.stream._handle.readStop) {
    slowClient.stream._handle.readStop()
  } else {
    t.skip('readStop() not available')
    return
  }

  // Publisher
  const publisher = await mqtt.connectAsync({
    port,
    keepalive: 0,
    clientId: 'bug-pub'
  })

  const payload = Buffer.alloc(256 * 1024, 'B')
  const NUM_MESSAGES = 50

  // Send all messages
  for (let i = 0; i < NUM_MESSAGES; i++) {
    publisher.publish('bug/test', payload, { qos: 0 })
  }

  // Wait for delivery attempts
  await delay(1000)

  slowClient.end(true)
  fastClient.end(true)
  publisher.end(true)

  // STRICT ASSERTIONS
  t.assert.strictEqual(writeReturnedFalse, true,
    'Must trigger backpressure for this test to be valid')

  // Fast client should NOT receive all messages because slow client blocks
  t.assert.ok(fastReceived < NUM_MESSAGES,
    `Fast client should NOT receive all ${NUM_MESSAGES} messages (received ${fastReceived})`)

  // Throughput should be severely degraded (<50%)
  t.assert.ok(fastReceived < NUM_MESSAGES * 0.5,
    `Throughput should be severely degraded (<50%), got ${((fastReceived / NUM_MESSAGES) * 100).toFixed(1)}%`)
})
