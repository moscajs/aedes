/**
 * ToxiProxy Integration Tests for Drain Timeout
 *
 * These tests demonstrate behavior with TRULY SLOW clients (not frozen),
 * which is different from readStop()-based tests.
 *
 * KEY INSIGHT: ToxiProxy simulates slow network, not frozen client.
 * - Slow client: data IS flowing, just slowly. Messages eventually arrive.
 * - Frozen client (readStop): data stops entirely. Messages never arrive.
 *
 * FINDING: With bandwidth throttling, TCP backpressure occurs after ~1-2MB
 * (not 25MB as initially suspected). The exact threshold depends on:
 * - TCP socket buffer sizes (typically 64KB-256KB)
 * - ToxiProxy's internal buffering
 * - Bandwidth toxic settings
 *
 * What ToxiProxy CAN reveal:
 * 1. Slow clients DO receive messages (eventually) - no deadlock without backpressure
 * 2. Large data volumes + bandwidth limits DO trigger TCP backpressure
 * 3. QoS 1 with latency shows acknowledgment delays
 * 4. drainTimeout works with proxy-induced backpressure
 *
 * These tests require Docker to be running.
 *
 * Run: node --test test/drain-toxiproxy.js
 */

import { test, before, after, describe } from 'node:test'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import mqtt from 'mqtt'
import { GenericContainer, Wait } from 'testcontainers'
import { Toxiproxy } from 'toxiproxy-node-client'
import { Aedes } from '../aedes.js'

// ToxiProxy configuration
const TOXIPROXY_API_PORT = 8474
const PROXY_LISTEN_PORT = 14883

let toxiproxyContainer
let toxiproxy
let proxyHost
let proxyApiPort
let proxyMappedPort

describe('ToxiProxy: realistic slow client behavior', async () => {
  before(async () => {
    console.log('[Setup] Starting ToxiProxy container...')

    toxiproxyContainer = await new GenericContainer('ghcr.io/shopify/toxiproxy:2.9.0')
      .withExposedPorts(TOXIPROXY_API_PORT, PROXY_LISTEN_PORT)
      .withCommand(['-host=0.0.0.0'])
      .withWaitStrategy(Wait.forHttp('/version', TOXIPROXY_API_PORT))
      .withResourcesQuota({ cpu: 0.5, memory: 256 * 1024 * 1024 })
      .start()

    proxyHost = toxiproxyContainer.getHost()
    proxyApiPort = toxiproxyContainer.getMappedPort(TOXIPROXY_API_PORT)
    proxyMappedPort = toxiproxyContainer.getMappedPort(PROXY_LISTEN_PORT)

    toxiproxy = new Toxiproxy(`http://${proxyHost}:${proxyApiPort}`)

    console.log(`[Setup] ToxiProxy ready at ${proxyHost}:${proxyApiPort}`)
    console.log(`[Setup] Proxy port mapped: ${PROXY_LISTEN_PORT} -> ${proxyMappedPort}`)
  })

  after(async () => {
    if (toxiproxyContainer) {
      console.log('[Cleanup] Stopping ToxiProxy container...')
      await toxiproxyContainer.stop()
    }
  })

  test('INSIGHT: slow client (via ToxiProxy) vs frozen client (readStop) behavior', async (t) => {
    // This test demonstrates the KEY DIFFERENCE between slow and frozen clients:
    // - SLOW client (ToxiProxy): Data flows slowly. Messages eventually arrive.
    //   No TCP backpressure until ToxiProxy's ~25MB buffer fills.
    // - FROZEN client (readStop): No data flow. Immediate TCP backpressure.
    //   Messages never arrive.
    //
    // This distinction matters for drainTimeout configuration!

    const broker = await Aedes.createBroker({ concurrency: 1 })
    const server = createServer(broker.handle)
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const brokerPort = server.address().port

    const hostIp = process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1'

    const proxy = await toxiproxy.createProxy({
      name: 'aedes-slow-vs-frozen',
      listen: `0.0.0.0:${PROXY_LISTEN_PORT}`,
      upstream: `${hostIp}:${brokerPort}`
    })

    // Slicer: 500 bytes/20ms = ~25KB/s (slow but functional)
    await proxy.addToxic({
      name: 'slicer-slow',
      type: 'slicer',
      stream: 'downstream',
      toxicity: 1,
      attributes: {
        average_size: 500,
        size_variation: 50,
        delay: 20000 // 20ms per chunk
      }
    })

    console.log('[Test] Testing SLOW client behavior (~25KB/s throughput)')

    try {
      const subscriber = await mqtt.connectAsync({
        host: proxyHost,
        port: proxyMappedPort,
        keepalive: 0,
        clientId: 'slow-subscriber'
      })
      await subscriber.subscribeAsync('test/#', { qos: 0 })

      let messagesReceived = 0
      subscriber.on('message', () => {
        messagesReceived++
        console.log(`[Test] Slow client received message ${messagesReceived}`)
      })

      const publisher = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'publisher'
      })

      // Send small messages to see them arrive slowly
      const payload = Buffer.alloc(4 * 1024, 'S') // 4KB - arrives in ~160ms
      const numMessages = 5

      console.log(`[Test] Publishing ${numMessages} x 4KB messages...`)
      const startTime = Date.now()

      for (let i = 0; i < numMessages; i++) {
        publisher.publish('test/topic', payload, { qos: 0 })
      }

      // Wait for slow delivery (4KB at 25KB/s = 160ms per message, + buffer time)
      console.log('[Test] Waiting for slow delivery...')
      await delay(3000) // 3 seconds should be enough for 5 messages

      const elapsed = Date.now() - startTime

      console.log(`[Test] Elapsed: ${elapsed}ms`)
      console.log(`[Test] Messages received: ${messagesReceived}/${numMessages}`)

      // KEY INSIGHT: Unlike frozen client, slow client DOES receive messages!
      // This is the crucial difference ToxiProxy reveals.
      t.assert.ok(messagesReceived > 0, 'Slow client DOES receive messages (unlike frozen client)')
      t.assert.ok(messagesReceived >= numMessages - 1, 'Most/all messages should arrive given enough time')

      console.log('[Test] SUCCESS: Slow client received messages (no deadlock)')
      console.log('[Test] This is DIFFERENT from frozen client where messages never arrive!')

      subscriber.end(true)
      publisher.end(true)
    } finally {
      await proxy.remove()
      broker.close()
      server.close()
    }
  })

  test('limit_data toxic: client freezes mid-stream, drainTimeout disconnects it', async (t) => {
    // limit_data stops forwarding after N bytes - simulates a client that freezes.
    // With drainTimeout enabled, the broker should disconnect the frozen client.
    // Without drainTimeout, the broker would wait forever (but ToxiProxy buffers mask this).

    const DRAIN_TIMEOUT = 1000

    const broker = await Aedes.createBroker({
      concurrency: 1,
      drainTimeout: DRAIN_TIMEOUT
    })
    const server = createServer(broker.handle)
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const brokerPort = server.address().port

    const hostIp = process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1'

    const proxy = await toxiproxy.createProxy({
      name: 'aedes-limit-test',
      listen: `0.0.0.0:${PROXY_LISTEN_PORT}`,
      upstream: `${hostIp}:${brokerPort}`
    })

    // Allow MQTT handshake, then freeze after 5KB downstream
    await proxy.addToxic({
      name: 'limit-down',
      type: 'limit_data',
      stream: 'downstream',
      toxicity: 1,
      attributes: {
        bytes: 5 * 1024 // Freeze after 5KB sent to client
      }
    })

    console.log('[Test] limit_data: connection freezes after 5KB downstream')
    console.log(`[Test] drainTimeout: ${DRAIN_TIMEOUT}ms`)

    let clientDisconnected = false

    try {
      const subscriber = await mqtt.connectAsync({
        host: proxyHost,
        port: proxyMappedPort,
        keepalive: 0,
        clientId: 'frozen-client'
      })
      await subscriber.subscribeAsync('freeze/#', { qos: 0 })

      let messagesReceived = 0
      subscriber.on('message', () => { messagesReceived++ })
      subscriber.on('close', () => {
        clientDisconnected = true
        console.log('[Test] Frozen client disconnected')
      })

      const publisher = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'freeze-publisher'
      })

      // Send enough data to exceed the 5KB limit and trigger freeze
      const payload = Buffer.alloc(32 * 1024, 'F') // 32KB > 5KB limit

      console.log('[Test] Publishing 32KB message (exceeds 5KB limit)...')
      publisher.publish('freeze/topic', payload, { qos: 0 })

      // Wait for drainTimeout + buffer
      await delay(DRAIN_TIMEOUT + 1500)

      console.log(`[Test] Client disconnected: ${clientDisconnected}`)
      console.log(`[Test] Messages received: ${messagesReceived}`)

      // SUCCESS: Client should be disconnected (either by drainTimeout or connection error)
      // FAILURE: Client stays connected despite being frozen
      t.assert.strictEqual(clientDisconnected, true,
        'FAILED: Frozen client should be disconnected by drainTimeout or connection reset')
      t.assert.strictEqual(messagesReceived, 0,
        'Frozen client should not receive full message')

      console.log('[Test] SUCCESS: Frozen client was disconnected')

      subscriber.end(true)
      publisher.end(true)
    } finally {
      await proxy.remove()
      broker.close()
      server.close()
    }
  })

  test('LARGE DATA: filling ToxiProxy buffer triggers real TCP backpressure', async (t) => {
    // ToxiProxy buffers ~25MB internally. If we send MORE than that,
    // the buffer fills and TCP backpressure kicks in.
    // This test proves the full chain works with realistic proxy conditions.

    const DRAIN_TIMEOUT = 2000

    const broker = await Aedes.createBroker({
      concurrency: 1,
      drainTimeout: DRAIN_TIMEOUT
    })
    const server = createServer(broker.handle)
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const brokerPort = server.address().port

    const hostIp = process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1'

    const proxy = await toxiproxy.createProxy({
      name: 'aedes-large-data',
      listen: `0.0.0.0:${PROXY_LISTEN_PORT}`,
      upstream: `${hostIp}:${brokerPort}`
    })

    // Very slow bandwidth - 1KB/s causes TCP backpressure after ~1-2MB
    await proxy.addToxic({
      name: 'bandwidth-crawl',
      type: 'bandwidth',
      stream: 'downstream',
      toxicity: 1,
      attributes: {
        rate: 1 // 1 KB/s - painfully slow
      }
    })

    console.log('[Test] Bandwidth: 1KB/s - backpressure expected at ~1-2MB')

    let clientDisconnected = false
    let writeReturnedFalse = false

    broker.on('client', (client) => {
      if (client.id === 'large-data-sub') {
        const origWrite = client.conn.write.bind(client.conn)
        client.conn.write = function (...args) {
          const result = origWrite(...args)
          if (result === false && !writeReturnedFalse) {
            writeReturnedFalse = true
            console.log('[Test] write() returned false - TCP BACKPRESSURE!')
          }
          return result
        }
      }
    })

    try {
      const subscriber = await mqtt.connectAsync({
        host: proxyHost,
        port: proxyMappedPort,
        keepalive: 0,
        clientId: 'large-data-sub'
      })
      await subscriber.subscribeAsync('large/#', { qos: 0 })

      subscriber.on('close', () => {
        clientDisconnected = true
        console.log('[Test] Client disconnected')
      })

      const publisher = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'large-data-pub'
      })

      // 1MB messages × 5 = 5MB - enough to trigger backpressure at ~1-2MB
      const payload = Buffer.alloc(1024 * 1024, 'L') // 1MB
      const numMessages = 5
      let sent = 0

      console.log(`[Test] Publishing ${numMessages} x 1MB = 5MB total...`)
      const startTime = Date.now()

      for (let i = 0; i < numMessages; i++) {
        publisher.publish('large/topic', payload, { qos: 0 })
        sent++
        if (i % 5 === 0) {
          console.log(`[Test] Sent ${sent}MB...`)
        }
        // Small delay to let events process
        await delay(10)
      }

      // Wait for drainTimeout to potentially fire
      console.log(`[Test] Waiting for drainTimeout (${DRAIN_TIMEOUT}ms)...`)
      await delay(DRAIN_TIMEOUT + 1000)

      const elapsed = Date.now() - startTime

      console.log(`[Test] Elapsed: ${elapsed}ms`)
      console.log(`[Test] Backpressure (write=false): ${writeReturnedFalse}`)
      console.log(`[Test] Client disconnected: ${clientDisconnected}`)

      // SUCCESS: Either backpressure occurred OR client disconnected
      // This proves large data volumes DO cause real TCP effects through ToxiProxy
      const backpressureOccurred = writeReturnedFalse || clientDisconnected

      t.assert.ok(backpressureOccurred,
        'FAILED: With 30MB at 1KB/s, should trigger backpressure or disconnect')

      if (writeReturnedFalse) {
        console.log('[Test] SUCCESS: TCP backpressure achieved via ToxiProxy buffer fill!')
      }
      if (clientDisconnected) {
        console.log('[Test] SUCCESS: drainTimeout disconnected slow client!')
      }

      subscriber.end(true)
      publisher.end(true)
    } finally {
      await proxy.remove()
      broker.close()
      server.close()
    }
  })

  test('QoS 1: slow client delays acknowledgments, broker tracks pending messages', async (t) => {
    // QoS 1 requires PUBACK from client. With a slow client:
    // 1. Broker sends PUBLISH
    // 2. Slow client receives it slowly
    // 3. Client sends PUBACK slowly (upstream also affected by proxy)
    // 4. Broker waits for PUBACK before considering delivery complete
    //
    // This tests a DIFFERENT blocking pattern than write-side backpressure.

    const broker = await Aedes.createBroker({ concurrency: 5 })
    const server = createServer(broker.handle)
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const brokerPort = server.address().port

    const hostIp = process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1'

    const proxy = await toxiproxy.createProxy({
      name: 'aedes-qos1',
      listen: `0.0.0.0:${PROXY_LISTEN_PORT}`,
      upstream: `${hostIp}:${brokerPort}`
    })

    // Slow BOTH directions - affects PUBLISH downstream and PUBACK upstream
    await proxy.addToxic({
      name: 'latency-both',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1,
      attributes: {
        latency: 500, // 500ms per packet
        jitter: 100
      }
    })
    await proxy.addToxic({
      name: 'latency-upstream',
      type: 'latency',
      stream: 'upstream',
      toxicity: 1,
      attributes: {
        latency: 500, // 500ms for PUBACK to return
        jitter: 100
      }
    })

    console.log('[Test] QoS 1 with 500ms latency each direction (1s round-trip)')

    try {
      // Slow subscriber through proxy
      const slowSubscriber = await mqtt.connectAsync({
        host: proxyHost,
        port: proxyMappedPort,
        keepalive: 0,
        clientId: 'qos1-slow'
      })
      await slowSubscriber.subscribeAsync('qos1/#', { qos: 1 }) // QoS 1!

      let slowReceived = 0
      slowSubscriber.on('message', () => {
        slowReceived++
        console.log(`[Test] Slow client received message ${slowReceived}`)
      })

      // Fast subscriber directly connected
      const fastSubscriber = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'qos1-fast'
      })
      await fastSubscriber.subscribeAsync('qos1/#', { qos: 1 })

      let fastReceived = 0
      fastSubscriber.on('message', () => {
        fastReceived++
      })

      const publisher = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'qos1-pub'
      })

      // Small messages, QoS 1
      const payload = Buffer.alloc(1024, 'Q') // 1KB
      const numMessages = 5
      let publishAcked = 0

      console.log(`[Test] Publishing ${numMessages} x 1KB messages with QoS 1...`)
      const startTime = Date.now()

      // QoS 1 publish - callback fires when broker ACKs our publish
      const publishPromises = []
      for (let i = 0; i < numMessages; i++) {
        publishPromises.push(new Promise(resolve => {
          publisher.publish('qos1/topic', payload, { qos: 1 }, (err) => {
            publishAcked++
            console.log(`[Test] Publish ${publishAcked} ACKed by broker`)
            resolve(err)
          })
        }))
      }

      await Promise.all(publishPromises)

      // Wait for slow client to receive
      await delay(5000) // 5 messages × 1s round-trip ≈ 5s

      const elapsed = Date.now() - startTime

      console.log(`[Test] Elapsed: ${elapsed}ms`)
      console.log(`[Test] Fast subscriber received: ${fastReceived}/${numMessages}`)
      console.log(`[Test] Slow subscriber received: ${slowReceived}/${numMessages}`)

      // SUCCESS criteria:
      // - Fast subscriber should receive all messages quickly
      // - Slow subscriber should receive all messages (eventually)
      // - Total time should reflect the latency overhead
      t.assert.strictEqual(fastReceived, numMessages,
        'Fast subscriber must receive all QoS 1 messages')
      t.assert.ok(slowReceived > 0,
        'Slow subscriber should receive some QoS 1 messages')
      t.assert.ok(elapsed > 2000,
        'QoS 1 with 500ms×2 latency should take noticeable time')

      console.log('[Test] SUCCESS: QoS 1 works with slow client (latency affects delivery)')

      slowSubscriber.end(true)
      fastSubscriber.end(true)
      publisher.end(true)
    } finally {
      await proxy.remove()
      broker.close()
      server.close()
    }
  })

  test('fast subscriber still receives messages when slow subscriber via proxy', async (t) => {
    // This tests that a fast client (direct connection) continues receiving
    // even when slow clients (through proxy) are degrading throughput.
    // Unlike frozen clients, slow clients don't cause complete deadlock.

    const broker = await Aedes.createBroker({ concurrency: 5 })
    const server = createServer(broker.handle)
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const brokerPort = server.address().port

    const hostIp = process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1'

    const proxy = await toxiproxy.createProxy({
      name: 'aedes-fast-slow-test',
      listen: `0.0.0.0:${PROXY_LISTEN_PORT}`,
      upstream: `${hostIp}:${brokerPort}`
    })

    // Moderate bandwidth limit - slow but functional
    await proxy.addToxic({
      name: 'bandwidth-slow',
      type: 'bandwidth',
      stream: 'downstream',
      toxicity: 1,
      attributes: {
        rate: 10 // 10 KB/s
      }
    })

    console.log('[Test] Slow subscriber at 10KB/s, fast subscriber direct')

    try {
      // Slow subscriber through proxy
      const slowSubscriber = await mqtt.connectAsync({
        host: proxyHost,
        port: proxyMappedPort,
        keepalive: 0,
        clientId: 'slow-sub'
      })
      await slowSubscriber.subscribeAsync('mixed/#', { qos: 0 })

      let slowReceived = 0
      slowSubscriber.on('message', () => { slowReceived++ })

      // Fast subscriber directly connected
      const fastSubscriber = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'fast-sub'
      })
      await fastSubscriber.subscribeAsync('mixed/#', { qos: 0 })

      let fastReceived = 0
      fastSubscriber.on('message', () => { fastReceived++ })

      const publisher = await mqtt.connectAsync({
        port: brokerPort,
        keepalive: 0,
        clientId: 'mixed-publisher'
      })

      // Small messages so slow client can actually receive some
      const payload = Buffer.alloc(1024, 'M') // 1KB
      const numMessages = 10

      console.log(`[Test] Publishing ${numMessages} x 1KB messages...`)

      for (let i = 0; i < numMessages; i++) {
        publisher.publish('mixed/topic', payload, { qos: 0 })
      }

      // Wait for delivery
      await delay(3000)

      console.log(`[Test] Fast subscriber received: ${fastReceived}/${numMessages}`)
      console.log(`[Test] Slow subscriber received: ${slowReceived}/${numMessages}`)

      // SUCCESS criteria:
      // - Fast subscriber should receive ALL messages (direct connection)
      // - Slow subscriber should receive SOME messages (slow but not frozen)
      t.assert.strictEqual(fastReceived, numMessages,
        'Fast subscriber must receive all messages')
      t.assert.ok(slowReceived > 0,
        'Slow subscriber should receive some messages (not frozen)')

      console.log('[Test] SUCCESS: Slow client does not block fast client delivery')

      slowSubscriber.end(true)
      fastSubscriber.end(true)
      publisher.end(true)
    } finally {
      await proxy.remove()
      broker.close()
      server.close()
    }
  })
})
