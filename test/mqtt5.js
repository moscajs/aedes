import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, createConnection } from 'node:net'
import mqtt from 'mqtt'
import { generate, parser as createParser } from 'mqtt-packet'
import { Aedes } from '../aedes.js'

// Spin up a real TCP server backed by aedes and return a helper to connect
// MQTT 5.0 clients to it. Exercises the full wire protocol (properties,
// reason codes) rather than the in-memory mqtt-packet harness.
async function createServerAndConnect (t, { brokerOptions } = {}) {
  const broker = await Aedes.createBroker(brokerOptions)
  const server = createServer(broker.handle)
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  const clients = []

  // Deterministic, fully-awaited teardown: end the clients, then close the
  // broker (which destroys their connections) and finally the server. Awaiting
  // each step releases all sockets/handles before the next test runs, which
  // avoids the connection-churn flakiness that intermittently stalled a
  // client connect when cleanup was fire-and-forget.
  t.after(async () => {
    for (const client of clients) {
      client.end(true)
    }
    await new Promise(resolve => broker.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })

  const connect = (opts = {}) => {
    const client = mqtt.connect({
      port,
      host: 'localhost',
      protocolVersion: 5,
      // Short connect timeout so a rare stalled initial connect retries
      // quickly instead of waiting out mqtt.js's 30s default.
      connectTimeout: 4000,
      ...opts
    })
    clients.push(client)
    return client
  }
  return { broker, server, port, connect }
}

test('MQTT 5.0 client connects and receives a v5 CONNACK', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)
  const client = connect()
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.cmd, 'connack')
  // v5 CONNACK carries a reasonCode (0 = success), not a v3/v4 returnCode
  t.assert.equal(connack.reasonCode, 0)
})

test('MQTT 5.0 publish/subscribe round-trip', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const sub = connect({ clientId: 'sub-v5' })
  await once(sub, 'connect')
  await sub.subscribeAsync('hello')

  const pub = connect({ clientId: 'pub-v5' })
  await once(pub, 'connect')

  const message = once(sub, 'message')
  await pub.publishAsync('hello', 'world')

  const [topic, payload] = await message
  t.assert.equal(topic, 'hello')
  t.assert.equal(payload.toString(), 'world')
})

test('MQTT 5.0 properties are forwarded to subscribers', async (t) => {
  t.plan(4)
  const { connect } = await createServerAndConnect(t)

  const sub = connect({ clientId: 'sub-props' })
  await once(sub, 'connect')
  await sub.subscribeAsync('props/topic')

  const pub = connect({ clientId: 'pub-props' })
  await once(pub, 'connect')

  const message = once(sub, 'message')
  await pub.publishAsync('props/topic', 'payload', {
    properties: {
      contentType: 'application/json',
      responseTopic: 'reply/here',
      correlationData: Buffer.from('corr-1'),
      userProperties: { foo: 'bar' }
    }
  })

  const [, , packet] = await message
  const props = packet.properties || {}
  t.assert.equal(props.contentType, 'application/json', 'contentType forwarded')
  t.assert.equal(props.responseTopic, 'reply/here', 'responseTopic forwarded')
  t.assert.deepEqual(props.userProperties, { foo: 'bar' }, 'userProperties forwarded')
  t.assert.deepEqual(props.correlationData, Buffer.from('corr-1'), 'correlationData forwarded')
})

test('MQTT 5.0 CONNACK advertises topicAliasMaximum when enabled', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 10 }
  })
  const client = connect()
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.topicAliasMaximum, 10)
})

test('MQTT 5.0 inbound topic alias is resolved and delivered with the real topic', async (t) => {
  t.plan(4)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 10 }
  })

  const sub = connect({ clientId: 'alias-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('alias/topic')

  // autoAssignTopicAlias makes mqtt.js register an alias on the first publish
  // and send subsequent publishes to the same topic with an empty topic + alias.
  const pub = connect({ clientId: 'alias-pub', autoAssignTopicAlias: true })
  await once(pub, 'connect')

  const first = once(sub, 'message')
  await pub.publishAsync('alias/topic', 'one')
  const [topic1, payload1] = await first
  t.assert.equal(topic1, 'alias/topic', 'first publish delivered with topic')
  t.assert.equal(payload1.toString(), 'one')

  const second = once(sub, 'message')
  await pub.publishAsync('alias/topic', 'two')
  const [topic2, payload2] = await second
  t.assert.equal(topic2, 'alias/topic', 'aliased publish delivered with resolved topic')
  t.assert.equal(payload2.toString(), 'two')
})

test('MQTT 5.0 subscription identifier is echoed on matching publishes', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const sub = connect({ clientId: 'subid-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('subid/topic', { properties: { subscriptionIdentifier: 42 } })

  const pub = connect({ clientId: 'subid-pub' })
  await once(pub, 'connect')

  const message = once(sub, 'message')
  await pub.publishAsync('subid/topic', 'hello')

  const [, , packet] = await message
  t.assert.equal(packet.properties?.subscriptionIdentifier, 42)
})

test('MQTT 5.0 subscription identifier survives a non-clean reconnect', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  // First session: subscribe with a subscription identifier. A non-zero
  // sessionExpiryInterval is required for the session to persist past
  // disconnect under MQTT 5.0 semantics.
  const first = connect({
    clientId: 'subid-persist',
    clean: false,
    properties: { sessionExpiryInterval: 60 }
  })
  await once(first, 'connect')
  await first.subscribeAsync('subid/persist', {
    qos: 1,
    properties: { subscriptionIdentifier: 7 }
  })
  first.end(true)
  await once(first, 'close')

  // Reconnect without re-subscribing; the subscription (and its identifier)
  // must be restored from persistence.
  const second = connect({
    clientId: 'subid-persist',
    clean: false,
    properties: { sessionExpiryInterval: 60 }
  })
  await once(second, 'connect')

  const pub = connect({ clientId: 'subid-persist-pub' })
  await once(pub, 'connect')

  const message = once(second, 'message')
  await pub.publishAsync('subid/persist', 'after-reconnect', { qos: 1 })

  const [, , packet] = await message
  t.assert.equal(packet.properties?.subscriptionIdentifier, 7)
})

test('MQTT 5.0 session is resumed within the expiry window', async (t) => {
  t.plan(3)
  const { connect } = await createServerAndConnect(t)

  const first = connect({
    clientId: 'expiry-resume',
    clean: false,
    properties: { sessionExpiryInterval: 60 }
  })
  const [connack1] = await once(first, 'connect')
  t.assert.equal(connack1.sessionPresent, false, 'no session on first connect')
  await first.subscribeAsync('expiry/resume', { qos: 1 })
  first.end(true)
  await once(first, 'close')

  // Reconnect well within the 60s window: the session must be resumed.
  const second = connect({
    clientId: 'expiry-resume',
    clean: false,
    properties: { sessionExpiryInterval: 60 }
  })
  const [connack2] = await once(second, 'connect')
  t.assert.equal(connack2.sessionPresent, true, 'session resumed on reconnect')

  // The subscription survived, so a publish is delivered without re-subscribing.
  const pub = connect({ clientId: 'expiry-resume-pub' })
  await once(pub, 'connect')
  const message = once(second, 'message')
  await pub.publishAsync('expiry/resume', 'still-subscribed', { qos: 1 })
  const [, payload] = await message
  t.assert.equal(payload.toString(), 'still-subscribed')
})

test('MQTT 5.0 session is wiped after the expiry interval elapses', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const first = connect({
    clientId: 'expiry-gone',
    clean: false,
    properties: { sessionExpiryInterval: 1 } // 1 second
  })
  const [connack1] = await once(first, 'connect')
  t.assert.equal(connack1.sessionPresent, false)
  await first.subscribeAsync('expiry/gone', { qos: 1 })
  first.end(true)
  await once(first, 'close')

  // Wait past the 1s expiry so the broker wipes the session.
  await delay(1300)

  const second = connect({ clientId: 'expiry-gone', clean: false })
  const [connack2] = await once(second, 'connect')
  t.assert.equal(connack2.sessionPresent, false, 'expired session is gone')
})

test('MQTT 5.0 session takeover sends DISCONNECT 0x8E to the old connection', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  // reconnectPeriod 0 so the displaced client does not loop reconnecting.
  const first = connect({ clientId: 'takeover', reconnectPeriod: 0 })
  await once(first, 'connect')

  const disconnected = once(first, 'disconnect')

  const second = connect({ clientId: 'takeover', reconnectPeriod: 0 })
  await once(second, 'connect')

  const [packet] = await disconnected
  t.assert.equal(packet.reasonCode, 0x8E, 'old connection told session taken over')
})

test('MQTT 5.0 will delay interval defers the will, then publishes it', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const watcher = connect({ clientId: 'willdelay-watch' })
  await once(watcher, 'connect')
  await watcher.subscribeAsync('willdelay/topic')

  const willClient = connect({
    clientId: 'willdelay-client',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: {
      topic: 'willdelay/topic',
      payload: 'delayed-bye',
      qos: 0,
      properties: { willDelayInterval: 1 } // 1 second
    }
  })
  await once(willClient, 'connect')

  // Abruptly drop the connection (no DISCONNECT packet).
  willClient.stream.destroy()

  // Not published immediately.
  const early = await Promise.race([
    once(watcher, 'message').then(() => 'message'),
    delay(300).then(() => 'timeout')
  ])
  t.assert.equal(early, 'timeout', 'will not published before the delay')

  // Published after the delay elapses. Bound the wait so a regression that
  // never fires the will fails the test instead of hanging the whole suite.
  const delivered = await Promise.race([
    once(watcher, 'message').then(([, payload]) => payload.toString()),
    delay(2000).then(() => null)
  ])
  t.assert.equal(delivered, 'delayed-bye', 'will published after delay')
})

test('MQTT 5.0 will delay is cancelled when the client reconnects', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t)

  const willClient = connect({
    clientId: 'willcancel-client',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: {
      topic: 'willcancel/topic',
      payload: 'should-not-arrive',
      qos: 0,
      // Long delay: the reconnect (not a timeout) must be what cancels it, so
      // the assertion is structural rather than a race against a real timer.
      properties: { willDelayInterval: 60 }
    }
  })
  await once(willClient, 'connect')
  willClient.stream.destroy()

  // The abrupt drop schedules the delayed will (several async hops after the TCP
  // RST — poll rather than sleep a fixed interval, which races under CI load).
  while (broker.delayedWills.size < 1) await delay(5)
  t.assert.equal(broker.delayedWills.size, 1, 'will scheduled after abrupt drop')

  // Reconnecting under the same client id must cancel the pending will.
  const reconnected = connect({ clientId: 'willcancel-client', reconnectPeriod: 0 })
  await once(reconnected, 'connect')
  t.assert.equal(broker.delayedWills.size, 0, 'pending will cancelled by reconnect')
})

// Shared subscriptions are deferred to a cluster-aware follow-up; the broker
// must advertise them as unavailable so v5 clients don't expect $share support.
test('MQTT 5.0 CONNACK advertises shared subscriptions as unavailable', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)
  const client = connect()
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.sharedSubscriptionAvailable, false)
})

test('MQTT 5.0 UNSUBACK carries reason codes and keeps the connection valid', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'unsub5' })
  await once(client, 'connect')
  await client.subscribeAsync('unsub/topic')

  // Unsubscribe one held topic and one that was never subscribed. Before v5
  // UNSUBACK reason codes were added, mqtt-packet would destroy the connection.
  await client.unsubscribeAsync(['unsub/topic', 'never/subscribed'])
  t.assert.equal(client.connected, true, 'connection still alive after v5 UNSUBACK')

  // The connection is genuinely healthy: a fresh pub/sub round-trip works.
  await client.subscribeAsync('after/unsub')
  const msg = once(client, 'message')
  await client.publishAsync('after/unsub', 'ok')
  const [, payload] = await msg
  t.assert.equal(payload.toString(), 'ok')
})

test('MQTT 5.0 queued message past its expiry interval is dropped', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const sub1 = connect({ clientId: 'msgexp-sub', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(sub1, 'connect')
  await sub1.subscribeAsync('msgexp/topic', { qos: 1 })
  sub1.end(true)
  await once(sub1, 'close')

  // Publish while the subscriber is offline, with a 1s message expiry.
  const pub = connect({ clientId: 'msgexp-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('msgexp/topic', 'too-late', {
    qos: 1,
    properties: { messageExpiryInterval: 1 }
  })

  // Reconnect after the message has expired. Listen before the connection is
  // established, since queued messages are delivered immediately on connect.
  await delay(1300)
  const sub2 = connect({ clientId: 'msgexp-sub', clean: false, properties: { sessionExpiryInterval: 60 } })
  const gotMessage = once(sub2, 'message').then(() => 'message')
  await once(sub2, 'connect')

  const result = await Promise.race([
    gotMessage,
    delay(400).then(() => 'timeout')
  ])
  t.assert.equal(result, 'timeout', 'expired queued message is not delivered')
})

test('MQTT 5.0 queued message within expiry is delivered with the remaining lifetime', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const sub1 = connect({ clientId: 'msgexp2-sub', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(sub1, 'connect')
  await sub1.subscribeAsync('msgexp2/topic', { qos: 1 })
  sub1.end(true)
  await once(sub1, 'close')

  const pub = connect({ clientId: 'msgexp2-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('msgexp2/topic', 'in-time', {
    qos: 1,
    properties: { messageExpiryInterval: 60 }
  })

  // Listen before connect resolves: the queued message is delivered immediately.
  const sub2 = connect({ clientId: 'msgexp2-sub', clean: false, properties: { sessionExpiryInterval: 60 } })
  const message = once(sub2, 'message')
  await once(sub2, 'connect')
  const [, payload, packet] = await message
  t.assert.equal(payload.toString(), 'in-time')
  const remaining = packet.properties?.messageExpiryInterval
  // Tight bound: delivery is near-immediate, so a correct recompute stays close
  // to the original 60s — a broken recompute that returned e.g. 1 would fail.
  t.assert.ok(remaining >= 58 && remaining <= 60, `remaining lifetime carried (${remaining}s)`)
})

test('MQTT 5.0 CONNACK advertises flow-control limits', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { maximumPacketSize: 256, receiveMaximum: 20 }
  })
  const client = connect()
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.maximumPacketSize, 256)
  t.assert.equal(connack.properties?.receiveMaximum, 20)
})

test('MQTT 5.0 oversized packet is rejected with DISCONNECT 0x95', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { maximumPacketSize: 100 }
  })
  const client = connect({ clientId: 'big-pub', reconnectPeriod: 0 })
  await once(client, 'connect')

  const disconnected = once(client, 'disconnect')
  // Payload well beyond the 100-byte limit.
  client.publish('big/topic', Buffer.alloc(500))

  const [packet] = await disconnected
  t.assert.equal(packet.reasonCode, 0x95, 'broker rejected oversized packet')
})

test('MQTT 5.0 oversized pre-auth CONNECT is dropped with a connectionError', async (t) => {
  t.plan(1)
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: { maximumPacketSize: 50 }
  })

  // A pre-auth client has no v5 DISCONNECT channel; an oversized CONNECT must
  // still be observable rather than silently closed. Use a raw socket so a
  // genuinely oversized CONNECT reaches the broker.
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'x'.repeat(200), // pushes the CONNECT past the 50-byte limit
    clean: true,
    keepalive: 0
  }, { protocolVersion: 5 }))

  const [, err] = await connErr
  t.assert.equal(err.message, 'packet too large')
})

test('MQTT 5.0 expired retained message is not delivered to new subscribers', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const pub = connect({ clientId: 'ret-exp-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('ret/exp', 'gone', {
    retain: true,
    properties: { messageExpiryInterval: 1 }
  })

  await delay(1300) // let it expire
  const sub = connect({ clientId: 'ret-exp-sub' })
  await once(sub, 'connect')
  const gotMessage = once(sub, 'message').then(() => 'message')
  await sub.subscribeAsync('ret/exp')

  const result = await Promise.race([
    gotMessage,
    delay(400).then(() => 'timeout')
  ])
  t.assert.equal(result, 'timeout', 'expired retained message not delivered')
})

test('MQTT 5.0 retained message within expiry is delivered with remaining lifetime', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const pub = connect({ clientId: 'ret-live-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('ret/live', 'here', {
    retain: true,
    properties: { messageExpiryInterval: 60, contentType: 'text/plain' }
  })

  const sub = connect({ clientId: 'ret-live-sub' })
  await once(sub, 'connect')
  const message = once(sub, 'message')
  await sub.subscribeAsync('ret/live')

  const [, payload, packet] = await message
  t.assert.equal(payload.toString(), 'here')
  const remaining = packet.properties?.messageExpiryInterval
  t.assert.ok(remaining >= 58 && remaining <= 60, `retained delivered with remaining lifetime (${remaining}s)`)
})

test('MQTT 5.0 unauthorized QoS1 publish is answered with 0x87 PUBACK, not a disconnect', async (t) => {
  t.plan(3)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizePublish: (client, packet, cb) => {
        cb(packet.topic.startsWith('denied') ? new Error('not allowed') : null)
      }
    }
  })

  const sub = connect({ clientId: 'unauth-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('denied/+')
  let received = false
  sub.on('message', () => { received = true })

  const pub = connect({ clientId: 'unauth-pub', reconnectPeriod: 0 })
  await once(pub, 'connect')
  // Capture the raw PUBACK off the wire to assert the reason code (not just
  // liveness): a broker that silently dropped the publish would otherwise pass.
  const acks = []
  pub.on('packetreceive', (p) => { if (p.cmd === 'puback') acks.push(p) })
  // mqtt.js may reject the publish on a >=0x80 reason code; either way the
  // connection must stay up and the message must not be delivered.
  try { await pub.publishAsync('denied/x', 'data', { qos: 1 }) } catch { /* 0x87 */ }
  // Wait for the actual PUBACK rather than a fixed sleep; then a short settle to
  // confirm the unauthorized message is not delivered.
  while (acks.length === 0) await delay(5)
  await delay(20)

  t.assert.equal(pub.connected, true, 'publisher connection stays alive')
  t.assert.equal(received, false, 'unauthorized message not delivered')
  t.assert.ok(acks.some(a => a.reasonCode === 0x87), 'PUBACK carried 0x87 Not authorized')
})

test('MQTT 5.0 unauthorized QoS2 publish is answered with 0x87 (PUBREC), not a disconnect', async (t) => {
  t.plan(3)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizePublish: (client, packet, cb) => {
        cb(packet.topic.startsWith('denied') ? new Error('not allowed') : null)
      }
    }
  })

  const sub = connect({ clientId: 'unauth2-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('denied/+')
  let received = false
  sub.on('message', () => { received = true })

  const pub = connect({ clientId: 'unauth2-pub', reconnectPeriod: 0 })
  await once(pub, 'connect')
  // The QoS 2 path answers with a 0x87 PUBREC (not PUBACK); assert the reason
  // code on the wire, and that the connection stays up / message not delivered.
  const acks = []
  pub.on('packetreceive', (p) => { if (p.cmd === 'pubrec') acks.push(p) })
  try { await pub.publishAsync('denied/x', 'data', { qos: 2 }) } catch { /* 0x87 */ }
  // Wait for the actual PUBREC rather than a fixed sleep; then a short settle to
  // confirm the unauthorized message is not delivered.
  while (acks.length === 0) await delay(5)
  await delay(20)

  t.assert.equal(pub.connected, true, 'publisher connection stays alive')
  t.assert.equal(received, false, 'unauthorized message not delivered')
  t.assert.ok(acks.some(a => a.reasonCode === 0x87), 'PUBREC carried 0x87 Not authorized')
})

test('MQTT 5.0 unauthorized publish PUBACK carries a Reason String, honoring Request Problem Information', async (t) => {
  t.plan(3)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizePublish: (client, packet, cb) => {
        cb(packet.topic.startsWith('denied') ? new Error('not allowed here') : null)
      }
    }
  })

  // Default Request Problem Information (1): the 0x87 PUBACK carries the broker's
  // error as a Reason String (#823).
  const pub = connect({ clientId: 'rpi-on', reconnectPeriod: 0 })
  await once(pub, 'connect')
  const acks = []
  pub.on('packetreceive', (p) => { if (p.cmd === 'puback') acks.push(p) })
  try { await pub.publishAsync('denied/x', 'd', { qos: 1 }) } catch { /* 0x87 */ }
  while (acks.length === 0) await delay(5)
  t.assert.equal(acks[0].reasonCode, 0x87, '0x87 Not authorized')
  t.assert.equal(acks[0].properties?.reasonString, 'not allowed here', 'Reason String present')

  // Request Problem Information = false [MQTT-3.1.2-29]: still 0x87, but no Reason String.
  const pub2 = connect({ clientId: 'rpi-off', reconnectPeriod: 0, properties: { requestProblemInformation: false } })
  await once(pub2, 'connect')
  const acks2 = []
  pub2.on('packetreceive', (p) => { if (p.cmd === 'puback') acks2.push(p) })
  try { await pub2.publishAsync('denied/y', 'd', { qos: 1 }) } catch { /* 0x87 */ }
  while (acks2.length === 0) await delay(5)
  t.assert.equal(acks2[0].properties?.reasonString, undefined, 'Reason String suppressed when RPI=0')
})

test('MQTT 5.0 a denied SUBSCRIBE returns SUBACK 0x87 and a Reason String', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizeSubscribe: (client, sub, cb) => cb(null, sub.topic === 'denied' ? null : sub)
    }
  })
  const client = connect({ clientId: 'sub-denied', reconnectPeriod: 0 })
  await once(client, 'connect')

  // mqtt.js rejects subscribeAsync when a granted code is >= 0x80; read the SUBACK
  // off the wire either way.
  const subacks = []
  client.on('packetreceive', p => { if (p.cmd === 'suback') subacks.push(p) })
  try { await client.subscribeAsync('denied') } catch { /* >= 0x80 rejects */ }
  while (subacks.length === 0) await delay(5)
  t.assert.deepEqual(subacks[0].granted, [0x87], 'denied subscription → 0x87 Not authorized')
  t.assert.equal(subacks[0].properties?.reasonString, 'not authorized to subscribe', 'SUBACK reason string [#823]')
})

test('MQTT 5.0 UNSUBACK carries a Reason String when no subscription existed', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'unsub-rs' })
  await once(client, 'connect')
  const unsubacks = []
  client.on('packetreceive', p => { if (p.cmd === 'unsuback') unsubacks.push(p) })
  await client.unsubscribeAsync('never/subscribed')
  while (unsubacks.length === 0) await delay(5)
  t.assert.ok(unsubacks[0].granted?.includes(0x11), '0x11 No subscription existed')
  t.assert.equal(unsubacks[0].properties?.reasonString, 'no subscription existed for one or more topic filters', 'UNSUBACK reason string [#823]')
})

test('MQTT 5.0 PUBCOMP for an unknown packet id carries 0x92 and a Reason String', async (t) => {
  t.plan(3)
  const { port } = await createServerAndConnect(t)
  // Raw v5 connection so we can send a PUBREL for a packet id the broker never saw.
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const pubcomps = []
  let connacked
  const ready = new Promise(resolve => { connacked = resolve })
  parser.on('packet', (p) => {
    if (p.cmd === 'connack') connacked()
    else if (p.cmd === 'pubcomp') pubcomps.push(p)
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'q2-pubcomp', clean: true, keepalive: 0 }, { protocolVersion: 5 }))
  await ready
  raw.write(generate({ cmd: 'pubrel', messageId: 4242 }, { protocolVersion: 5 }))
  while (pubcomps.length === 0) await delay(5)
  t.assert.equal(pubcomps[0].messageId, 4242, 'PUBCOMP echoes the messageId')
  t.assert.equal(pubcomps[0].reasonCode, 0x92, '0x92 Packet Identifier not found [#822]')
  t.assert.equal(pubcomps[0].properties?.reasonString, 'packet identifier not found', 'PUBCOMP reason string [#823]')
})

test('MQTT 5.0 a rejecting PUBREC (reason >= 0x80) ends QoS 2 without a PUBREL', async (t) => {
  // Covers both the clean path and the non-clean path (which releases the stored
  // outgoing packet id rather than sending a PUBREL). [MQTT 5.0 §4.3.3]
  t.plan(3)
  const { port, connect, broker } = await createServerAndConnect(t)

  // Raw v5 subscriber so we control the QoS 2 handshake and can reject the
  // delivered PUBLISH with a >= 0x80 PUBREC.
  async function rejectAndAssert (clientId, connectProps, checkRelease) {
    let pubrelSeen = false
    let subacked
    const subReady = new Promise(resolve => { subacked = resolve })
    const raw = createConnection(port, 'localhost')
    t.after(() => raw.destroy())
    raw.on('error', () => {})
    const parser = createParser({ protocolVersion: 5 })
    parser.on('packet', (p) => {
      if (p.cmd === 'connack') {
        raw.write(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'q2/reject', qos: 2 }] }, { protocolVersion: 5 }))
      } else if (p.cmd === 'suback') {
        subacked()
      } else if (p.cmd === 'publish') {
        raw.write(generate({ cmd: 'pubrec', messageId: p.messageId, reasonCode: 0x87 }, { protocolVersion: 5 }))
      } else if (p.cmd === 'pubrel') {
        pubrelSeen = true
      }
    })
    raw.on('data', d => parser.parse(d))
    raw.write(generate({ cmd: 'connect', protocolVersion: 5, clientId, keepalive: 0, ...connectProps }, { protocolVersion: 5 }))
    await subReady

    const pub = connect({ clientId: clientId + '-pub' })
    await once(pub, 'connect')
    await pub.publishAsync('q2/reject', 'x', { qos: 2 })
    // Negative assertion: wait a window for a (wrongly sent) PUBREL that must not come.
    await delay(150)
    t.assert.equal(pubrelSeen, false, `no PUBREL after a rejecting PUBREC (${clientId})`)

    // Non-clean path: the QoS 2 PUBLISH was persisted as outgoing state when it
    // was delivered; handlePubrec must release that packet id instead of leaving
    // it to be redelivered on reconnect. Assert the stored outgoing queue is now
    // empty — this is the half of the behaviour a "no PUBREL" check alone misses.
    if (checkRelease) {
      const outgoing = []
      for await (const stored of broker.persistence.outgoingStream({ id: clientId })) outgoing.push(stored)
      t.assert.equal(outgoing.length, 0, `stored outgoing packet id released after rejecting PUBREC (${clientId})`)
    }
    raw.destroy()
  }

  // Clean session: no persisted outgoing state to release.
  await rejectAndAssert('q2-reject-clean', { clean: true })
  // Non-clean session: the stored outgoing packet id is released instead.
  await rejectAndAssert('q2-reject-persist', { clean: false, properties: { sessionExpiryInterval: 60 } }, true)
})

test('MQTT 5.0 returns an Assigned Client Identifier for an empty clientId', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: '' })
  const [connack] = await once(client, 'connect')
  const assigned = connack.properties?.assignedClientIdentifier
  t.assert.ok(assigned, 'broker returned an assigned client identifier')
  // The broker must actually register the client under the assigned id.
  while (!broker.clients[assigned]) await delay(5)
  t.assert.ok(broker.clients[assigned], 'client registered under the assigned id')
})

test('MQTT 5.0 returns Response Information when requested and configured', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { responseInformation: 'resp/base' }
  })
  // Requested (requestResponseInformation) → the broker returns it.
  const a = connect({ clientId: 'ri-on', properties: { requestResponseInformation: true } })
  const [ca] = await once(a, 'connect')
  t.assert.equal(ca.properties?.responseInformation, 'resp/base', 'returned when requested')

  // Not requested → omitted, even though the broker is configured.
  const b = connect({ clientId: 'ri-off' })
  const [cb] = await once(b, 'connect')
  t.assert.equal(cb.properties?.responseInformation, undefined, 'omitted when not requested')
})

test('MQTT 5.0 Response Information can be a per-client function', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { responseInformation: (client) => `resp/${client.id}` }
  })
  const client = connect({ clientId: 'ri-fn', properties: { requestResponseInformation: true } })
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.responseInformation, 'resp/ri-fn', 'per-client value returned')
})

test('MQTT 5.0 Response Information is omitted when requested but the broker is not configured', async (t) => {
  t.plan(1)
  // Default (responseInformation: null): the "configured" half of the gate.
  const { connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'ri-none', properties: { requestResponseInformation: true } })
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.responseInformation, undefined, 'omitted when not configured')
})

test('MQTT 5.0 a Response Information function returning undefined (or throwing) omits the property', async (t) => {
  t.plan(4)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: {
      responseInformation: (client) => {
        // Opt out for one client; throw for another — both must degrade to omit,
        // never break the CONNACK.
        if (client.id === 'ri-throw') throw new Error('tenant lookup failed')
        return undefined
      }
    }
  })
  const a = connect({ clientId: 'ri-undef', properties: { requestResponseInformation: true } })
  const [ca] = await once(a, 'connect')
  t.assert.equal(ca.properties?.responseInformation, undefined, 'undefined return → omitted')

  // A throwing resolver still completes the handshake (property omitted) and the
  // failure is surfaced on clientError rather than swallowed silently.
  const clientError = once(broker, 'clientError')
  const b = connect({ clientId: 'ri-throw', properties: { requestResponseInformation: true } })
  const [cb] = await once(b, 'connect')
  t.assert.equal(cb.properties?.responseInformation, undefined, 'a throwing resolver → omitted, handshake intact')
  const [errClient, err] = await clientError
  t.assert.equal(errClient.id, 'ri-throw', 'clientError carries the affected client')
  t.assert.equal(err.message, 'tenant lookup failed', 'clientError carries the resolver error')
})

test('MQTT 5.0 preConnect can redirect a client with CONNACK 0x9C + Server Reference', async (t) => {
  t.plan(4)
  const { connect } = await createServerAndConnect(t, {
    // Advertise capabilities so we can prove the redirect CONNACK omits them.
    brokerOptions: {
      topicAliasMaximum: 10,
      receiveMaximum: 20,
      preConnect: (client, packet, cb) => {
        // #838: attach a serverReference to the rejection to redirect the client.
        cb(Object.assign(new Error('go elsewhere'), { serverReference: 'other-host:1883' }), false)
      }
    }
  })
  const client = connect({ clientId: 'redir-pc', reconnectPeriod: 0 })
  client.on('error', () => {}) // a >= 0x80 CONNACK surfaces as a client error
  // Plain close promise: events.once(…, 'close') would reject on the 0x9C 'error'.
  const closed = new Promise(resolve => client.once('close', resolve))
  // The CONNACK is the first packet the broker sends.
  const [connack] = await once(client, 'packetreceive')
  t.assert.equal(connack.reasonCode, 0x9C, '0x9C Use another server')
  t.assert.equal(connack.properties?.serverReference, 'other-host:1883', 'server reference on the wire')
  // A rejection CONNACK carries only the reason/serverReference, never the
  // broker-capability advertisement (doConnack skips it once reasonCode is set).
  t.assert.equal(connack.properties?.receiveMaximum, undefined, 'no broker-capability properties on a redirect CONNACK')
  await closed
  t.assert.equal(client.connected, false, 'connection closed after the redirect CONNACK')
})

test('MQTT 5.0 redirect: a non-redirect reasonCode paired with serverReference is clamped to 0x9C', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      preConnect: (client, packet, cb) => {
        // A success code (0x00) with a serverReference must not produce a
        // success-coded rejection — the broker clamps it to 0x9C.
        cb(Object.assign(new Error('go'), { serverReference: 'h:1883', reasonCode: 0x00 }), false)
      }
    }
  })
  const client = connect({ clientId: 'redir-clamp', reconnectPeriod: 0 })
  client.on('error', () => {})
  const [connack] = await once(client, 'packetreceive')
  t.assert.equal(connack.reasonCode, 0x9C, 'non-redirect reasonCode clamped to 0x9C')
})

test('MQTT 5.0 redirect: a non-v5 client carrying serverReference is not redirected', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      preConnect: (client, packet, cb) => {
        cb(Object.assign(new Error('go elsewhere'), { serverReference: 'other-host:1883' }), false)
      }
    }
  })
  // v4 has no server-side CONNACK properties; the redirect branch is v5-gated, so
  // the reference must be silently dropped (normal refusal, no redirect CONNACK).
  let sawServerRef = false
  const client = connect({ clientId: 'redir-v4', protocolVersion: 4, reconnectPeriod: 0 })
  client.on('error', () => {})
  client.on('packetreceive', (p) => { if (p.properties?.serverReference) sawServerRef = true })
  await new Promise(resolve => client.once('close', resolve))
  t.assert.equal(sawServerRef, false, 'v3/v4 reject drops serverReference (no redirect)')
})

test('MQTT 5.0 authenticate can redirect with a custom reason code (0x9D Server moved)', async (t) => {
  t.plan(3)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticate: (client, username, password, cb) => {
        cb(Object.assign(new Error('moved'), { serverReference: 'new-host:1883', reasonCode: 0x9D }), false)
      }
    }
  })
  const client = connect({ clientId: 'redir-auth', reconnectPeriod: 0 })
  client.on('error', () => {})
  const closed = new Promise(resolve => client.once('close', resolve))
  const [connack] = await once(client, 'packetreceive')
  t.assert.equal(connack.reasonCode, 0x9D, '0x9D Server moved (custom reason code)')
  t.assert.equal(connack.properties?.serverReference, 'new-host:1883', 'server reference on the wire')
  // [MQTT-3.2.2-7] a >= 0x80 CONNACK must close the connection (this path closes
  // via client.close.bind, distinct from the preConnect done(err) path).
  await closed
  t.assert.equal(client.connected, false, 'connection closed after the redirect CONNACK')
})

test('MQTT 5.0 server-initiated DISCONNECT can carry a Server Reference', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t)
  // Await clientReady for the broker-side client (emitted after connected=true),
  // rather than polling broker.clients.
  const ready = once(broker, 'clientReady')
  const client = connect({ clientId: 'redir-disc', reconnectPeriod: 0 })
  const [bclient] = await ready
  const disc = once(client, 'disconnect')
  bclient.disconnect({
    reasonCode: 0x9C,
    properties: { serverReference: 'elsewhere:1883' }
  })
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x9C, '0x9C on the DISCONNECT')
  t.assert.equal(packet.properties?.serverReference, 'elsewhere:1883', 'server reference on the DISCONNECT')
})

test('MQTT 5.0 imposes Server Keep Alive when the client exceeds the broker limit', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { keepaliveLimit: 30 }
  })
  // v5 client requesting a keepalive above the limit is not rejected; the
  // broker tells it to use 30 instead.
  const client = connect({ keepalive: 1000 })
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.serverKeepAlive, 30)
})

test('MQTT 5.0 DISCONNECT with will (reasonCode 0x04) publishes the will', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const sub = connect({ clientId: 'will-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('will/topic')

  const willClient = connect({
    clientId: 'will-client',
    will: {
      topic: 'will/topic',
      payload: 'goodbye',
      qos: 0,
      retain: false
    }
  })
  await once(willClient, 'connect')

  const message = once(sub, 'message')
  // reasonCode 0x04 = "Disconnect with Will Message"
  willClient.end(false, { reasonCode: 0x04 })

  const [topic, payload] = await message
  t.assert.equal(payload.toString(), 'goodbye', `will published on ${topic}`)
})

test('MQTT 5.0 publish with an out-of-range topic alias is rejected with DISCONNECT 0x94', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 5 }
  })
  const client = connect({ clientId: 'alias-bad', reconnectPeriod: 0 })
  await once(client, 'connect')

  // A compliant client never sends this; inject a raw PUBLISH whose topic alias
  // exceeds the advertised topicAliasMaximum so the broker rejects it.
  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate(
    { cmd: 'publish', topic: 'x', payload: 'p', qos: 0, properties: { topicAlias: 99 } },
    { protocolVersion: 5 }
  ))

  const [, err] = await clientError
  t.assert.equal(err.message, 'topic alias 99 is out of range (broker topicAliasMaximum is 5)')
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x94, '0x94 Topic Alias invalid on the wire')
})

test('MQTT 5.0 publish with an unknown topic alias is rejected with DISCONNECT 0x94', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 5 }
  })
  const client = connect({ clientId: 'alias-unknown', reconnectPeriod: 0 })
  await once(client, 'connect')

  // Empty topic + an in-range alias that was never registered: nothing resolves.
  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate(
    { cmd: 'publish', topic: '', payload: 'p', qos: 0, properties: { topicAlias: 3 } },
    { protocolVersion: 5 }
  ))

  const [, err] = await clientError
  t.assert.equal(err.message, 'unknown topic alias 3')
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x94, '0x94 Topic Alias invalid on the wire')
})

test('MQTT 5.0 publish with topic alias 0 is rejected with DISCONNECT 0x94', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 5 }
  })
  const client = connect({ clientId: 'alias-zero', reconnectPeriod: 0 })
  await once(client, 'connect')

  // [MQTT-3.3.2-8] A Topic Alias of 0 is invalid even when aliases are enabled —
  // a distinct boundary from the > max case. Inject it raw (a compliant client
  // never sends 0).
  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate(
    { cmd: 'publish', topic: 'x', payload: 'p', qos: 0, properties: { topicAlias: 0 } },
    { protocolVersion: 5 }
  ))

  const [, err] = await clientError
  t.assert.equal(err.message, 'topic alias 0 is out of range (broker topicAliasMaximum is 5)')
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x94, '0x94 Topic Alias invalid on the wire')
})

test('MQTT 5.0 publish with a topic alias when topicAliasMaximum is 0 is rejected with DISCONNECT 0x94', async (t) => {
  t.plan(2)
  // Default topicAliasMaximum (0) means inbound aliases are disabled — a distinct
  // semantic from an over-limit alias. Any alias must be rejected.
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'alias-disabled', reconnectPeriod: 0 })
  await once(client, 'connect')

  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate(
    { cmd: 'publish', topic: 'x', payload: 'p', qos: 0, properties: { topicAlias: 1 } },
    { protocolVersion: 5 }
  ))

  const [, err] = await clientError
  t.assert.equal(err.message, 'topic alias 1 is out of range (broker topicAliasMaximum is 0)')
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x94, '0x94 Topic Alias invalid on the wire')
})

test('MQTT 5.0 pendingSessionsLimit caps the number of pending session-expiry timers', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { pendingSessionsLimit: 1 }
  })
  // First disconnected session takes the single pending slot.
  const a = connect({ clientId: 'cap-a', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(a, 'connect')
  a.end(true)
  await once(a, 'close')
  while (broker.expiringSessions.size < 1) await delay(5)

  // Second exceeds the cap → expired immediately rather than queuing a timer.
  // Await the cap-trip event instead of a fixed sleep (deterministic).
  const limit = once(broker, 'sessionLimitReached')
  const b = connect({ clientId: 'cap-b', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(b, 'connect')
  b.end(true)
  await once(b, 'close')
  await limit
  t.assert.equal(broker.expiringSessions.size, 1, 'second pending session denied by the cap')
})

test('MQTT 5.0 a never-expiring session counts against pendingSessionsLimit and emits sessionLimitReached', async (t) => {
  t.plan(4)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { pendingSessionsLimit: 1 }
  })
  // A never-expiring (0xFFFFFFFF) session pins persisted state indefinitely, so
  // it must occupy a cap slot — otherwise a client cycling identities with
  // "never expires" would accumulate retained sessions without bound.
  const a = connect({ clientId: 'never-a', clean: false, properties: { sessionExpiryInterval: 0xFFFFFFFF } })
  await once(a, 'connect')
  a.end(true)
  await once(a, 'close')
  while (broker.expiringSessions.size < 1) await delay(5)
  t.assert.equal(broker.expiringSessions.size, 1, 'never-expiring session occupies a cap slot')

  // Second never-expiring session exceeds the cap → wiped now and the trip is
  // observable, instead of silently vanishing or accumulating unbounded.
  const limit = once(broker, 'sessionLimitReached')
  const b = connect({ clientId: 'never-b', clean: false, properties: { sessionExpiryInterval: 0xFFFFFFFF } })
  await once(b, 'connect')
  b.end(true)
  await once(b, 'close')
  const [client, info] = await limit
  t.assert.equal(client.id, 'never-b', 'sessionLimitReached emitted for the denied session')
  t.assert.equal(info.reason, 'sessionExpiry', 'discriminator marks the session-expiry path')
  t.assert.equal(broker.expiringSessions.size, 1, 'cap held; over-cap never-expiring session not retained')
})

test('MQTT 5.0 CONNACK carries the auth-failure reason code (0x87 plus the returnCode 2..5 map)', async (t) => {
  // authenticate maps a username to a returnCode so the whole connackReasonCodes
  // table is exercised; an unmapped user falls through to the default 0x87.
  const byUser = { id2: 2, id3: 3, id4: 4, id5: 5 }
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticate (client, username, password, cb) {
        if (username === 'ok') return cb(null, true)
        const rc = byUser[username]
        if (rc) {
          const err = new Error('rejected')
          err.returnCode = rc
          return cb(err, false)
        }
        cb(new Error('denied'), false) // no returnCode → defaults to 0x87
      }
    }
  })

  // Open a raw v5 connection, send CONNECT, resolve with the parsed CONNACK.
  const rawConnack = (connectProps) => new Promise((resolve, reject) => {
    const raw = createConnection(port, 'localhost')
    t.after(() => raw.destroy())
    raw.on('error', reject)
    const parser = createParser({ protocolVersion: 5 })
    parser.on('packet', (packet) => { if (packet.cmd === 'connack') resolve(packet) })
    parser.on('error', reject)
    raw.on('data', (chunk) => parser.parse(chunk))
    raw.write(generate({ cmd: 'connect', protocolVersion: 5, clean: true, keepalive: 0, ...connectProps }, { protocolVersion: 5 }))
  })

  const cases = [
    ['ok', 0x00], // success
    ['id2', 0x85], // identifier rejected → Client Identifier not valid
    ['id3', 0x88], // server unavailable
    ['id4', 0x86], // bad user name or password
    ['id5', 0x87], // not authorized
    ['denied', 0x87] // no returnCode → default not authorized
  ]
  t.plan(cases.length)
  for (const [username, code] of cases) {
    const connack = await rawConnack({ clientId: username, username })
    t.assert.equal(connack.reasonCode, code, `auth(${username}) → CONNACK reasonCode ${code}`)
  }
})

test('MQTT 5.0 Will Delay Interval is capped by the Session Expiry Interval', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const watcher = connect({ clientId: 'wd-watch' })
  await once(watcher, 'connect')
  await watcher.subscribeAsync('wd/cap')

  // willDelayInterval (60s) exceeds the Session Expiry Interval (1s). The will
  // must be published no later than session end — after ~1s (Math.min clamp),
  // not 60s — so a reversed-args regression would make this time out.
  const dying = connect({
    clientId: 'wd-die',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 1 },
    will: { topic: 'wd/cap', payload: 'bye', qos: 0, properties: { willDelayInterval: 60 } }
  })
  await once(dying, 'connect')
  const got = once(watcher, 'message')
  dying.stream.destroy() // ungraceful close → the will is in play

  const result = await Promise.race([
    got.then(([, payload]) => payload.toString()),
    delay(4000).then(() => 'timeout')
  ])
  t.assert.equal(result, 'bye', 'will fired at session expiry (~1s), proving the delay was clamped')
})

test('MQTT 5.0 broker clamps a requested Session Expiry Interval to sessionExpiryIntervalLimit', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { sessionExpiryIntervalLimit: 30 }
  })
  const client = connect({
    clientId: 'clamp-se',
    clean: false,
    properties: { sessionExpiryInterval: 0xFFFFFFFF } // "never" — must be clamped
  })
  const [connack] = await once(client, 'connect')
  // [MQTT-3.2.2-3.2] the applied (clamped) interval must be echoed in the CONNACK.
  t.assert.equal(connack.properties?.sessionExpiryInterval, 30,
    'clamped interval echoed in CONNACK')
  // ...and applied server-side.
  while (!broker.clients['clamp-se']?.connected) await delay(5)
  t.assert.equal(broker.clients['clamp-se'].sessionExpiryInterval, 30,
    'requested 0xFFFFFFFF clamped to the broker maximum')
})

test('MQTT 5.0 session with the maximum expiry interval is retained', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  const first = connect({
    clientId: 'never-expire',
    clean: false,
    properties: { sessionExpiryInterval: 0xFFFFFFFF } // never expires
  })
  const [connack1] = await once(first, 'connect')
  t.assert.equal(connack1.sessionPresent, false, 'no prior session')
  await first.subscribeAsync('never/expire', { qos: 1 })
  first.end(true)
  await once(first, 'close')

  // No expiry timer is armed; the session is kept until explicitly taken over.
  const second = connect({
    clientId: 'never-expire',
    clean: false,
    properties: { sessionExpiryInterval: 0xFFFFFFFF }
  })
  const [connack2] = await once(second, 'connect')
  t.assert.equal(connack2.sessionPresent, true, 'session retained across reconnect')
})

test('MQTT 5.0 DISCONNECT can extend the Session Expiry Interval to retain the session', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)

  // Connect with a short 1s expiry (non-zero, so the session is persistable)...
  const first = connect({
    clientId: 'disc-expiry',
    clean: false,
    properties: { sessionExpiryInterval: 1 }
  })
  const [connack1] = await once(first, 'connect')
  t.assert.equal(connack1.sessionPresent, false)
  await first.subscribeAsync('disc/expiry', { qos: 1 })

  // ...but the DISCONNECT raises it to 60s. Reconnecting past the original 1s
  // window proves the DISCONNECT-supplied interval took effect (otherwise the
  // session would already have been wiped).
  first.end(false, { properties: { sessionExpiryInterval: 60 } })
  await once(first, 'close')
  await delay(1300)

  const second = connect({
    clientId: 'disc-expiry',
    clean: false,
    properties: { sessionExpiryInterval: 60 }
  })
  const [connack2] = await once(second, 'connect')
  t.assert.equal(connack2.sessionPresent, true, 'session retained after DISCONNECT raised the interval')
})

test('MQTT 5.0 broker-initiated disconnect carries a reason code and properties', async (t) => {
  t.plan(4)
  const { broker, connect } = await createServerAndConnect(t)

  // Default reconnectPeriod is kept so a rare lost initial CONNACK still
  // recovers; each client is ended right after its assertion so it never
  // actually reconnects (a post-disconnect reconnect would collide with the
  // next connect and intermittently stall a CONNACK). The two clients are also
  // handled one at a time so their connects never overlap.
  // The client fires 'connect' as soon as it receives the CONNACK, but the
  // broker sets the server-side client.connected slightly later. disconnect()
  // only sends a v5 DISCONNECT packet when the client is connected, so we wait
  // for that flag before disconnecting (otherwise no DISCONNECT arrives and the
  // 'disconnect' listener below would hang).
  const serverConnected = (id) => new Promise(resolve => {
    const check = () => broker.clients[id]?.connected ? resolve() : setTimeout(check, 5)
    check()
  })

  const c1 = connect({ clientId: 'srv-disc-1' })
  await once(c1, 'connect')
  await serverConnected('srv-disc-1')
  const serverC1 = broker.clients['srv-disc-1']
  const disc = once(c1, 'disconnect')
  serverC1.disconnect({
    reasonCode: 0x8B, // Server shutting down
    properties: { reasonString: 'maintenance' }
  })
  const [packet] = await disc
  c1.end(true)
  t.assert.equal(packet.reasonCode, 0x8B, 'reason code delivered')
  t.assert.equal(packet.properties?.reasonString, 'maintenance', 'properties delivered')
  // The reason code is observable on the server-side client for ops/alerting.
  t.assert.equal(serverC1.disconnectReasonCode, 0x8B, 'disconnectReasonCode recorded')

  // Second client exercises the opts-as-callback signature: disconnect(done).
  const c2 = connect({ clientId: 'srv-disc-2' })
  await once(c2, 'connect')
  await serverConnected('srv-disc-2')
  let cbCalled = false
  await new Promise(resolve => broker.clients['srv-disc-2'].disconnect(() => {
    cbCalled = true
    resolve()
  }))
  c2.end(true)
  t.assert.ok(cbCalled, 'disconnect(callback) invoked the callback')
})

test('MQTT 5.0 broker close clears a pending delayed will', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t)

  const willClient = connect({
    clientId: 'willclose-client',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: {
      topic: 'willclose/topic',
      payload: 'bye',
      qos: 0,
      properties: { willDelayInterval: 60 } // long enough to stay pending
    }
  })
  await once(willClient, 'connect')

  // Drop the connection so the will is scheduled (but not yet published). Poll
  // the broker-side state rather than sleeping a fixed interval (CI-load race).
  willClient.stream.destroy()
  while (broker.delayedWills.size < 1) await delay(5)
  t.assert.equal(broker.delayedWills.size, 1, 'delayed will is pending')

  // Closing the broker must clear the pending will timer (no leaked timer). The
  // helper's teardown close() is idempotent, so closing here as well is safe.
  await new Promise(resolve => broker.close(resolve))
  t.assert.equal(broker.delayedWills.size, 0, 'pending will cleared on close')
})

test('MQTT 5.0 Clean Start discards a prior session\'s queued messages', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  // Establish a persistable session and queue a QoS 1 message while offline.
  const sub1 = connect({ clientId: 'cleanstart', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(sub1, 'connect')
  await sub1.subscribeAsync('cleanstart/topic', { qos: 1 })
  sub1.end(true)
  await once(sub1, 'close')

  const pub = connect({ clientId: 'cleanstart-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('cleanstart/topic', 'stale', { qos: 1 })

  // Reconnect with Clean Start = true (but still a non-zero expiry): the prior
  // session — including its queued message — must be discarded. [MQTT-3.1.2-4]
  const sub2 = connect({ clientId: 'cleanstart', clean: true, properties: { sessionExpiryInterval: 60 } })
  const got = once(sub2, 'message').then(() => 'message')
  await once(sub2, 'connect')
  const result = await Promise.race([got, delay(300).then(() => 'timeout')])
  t.assert.equal(result, 'timeout', 'queued message from the discarded session not delivered')
})

// Positive contrast for the test above: the same queue-while-offline scenario,
// but a non-clean (resume) reconnect DOES receive the message — proving the
// queue was populated and that the clean-start case discards it specifically.
test('MQTT 5.0 a non-clean reconnect receives the prior session\'s queued messages', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)

  const sub1 = connect({ clientId: 'noclean', clean: false, properties: { sessionExpiryInterval: 60 } })
  await once(sub1, 'connect')
  await sub1.subscribeAsync('noclean/topic', { qos: 1 })
  sub1.end(true)
  await once(sub1, 'close')

  const pub = connect({ clientId: 'noclean-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('noclean/topic', 'queued', { qos: 1 })

  // Resume (clean:false): the queued message must be delivered.
  const sub2 = connect({ clientId: 'noclean', clean: false, properties: { sessionExpiryInterval: 60 } })
  const message = once(sub2, 'message')
  await once(sub2, 'connect')
  const [, payload] = await message
  t.assert.equal(payload.toString(), 'queued', 'queued message delivered on a non-clean resume')
})

test('MQTT 5.0 CONNECT with receiveMaximum 0 is rejected (Protocol Error)', async (t) => {
  t.plan(1)
  const { broker, port } = await createServerAndConnect(t)

  // mqtt.js won't send an invalid receiveMaximum, so inject a raw v5 CONNECT.
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'rm0',
    clean: true,
    keepalive: 0,
    properties: { receiveMaximum: 0 }
  }, { protocolVersion: 5 }))

  const [, err] = await connErr
  t.assert.match(err.message, /Receive Maximum/, 'rejected with a Receive Maximum protocol error')
})

test('MQTT 5.0 SUBSCRIBE with subscriptionIdentifier 0 is rejected with DISCONNECT 0x82', async (t) => {
  t.plan(2)
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'si0', reconnectPeriod: 0 })
  await once(client, 'connect')

  // mqtt.js won't send an out-of-range identifier; inject a raw SUBSCRIBE.
  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate({
    cmd: 'subscribe',
    messageId: 1,
    subscriptions: [{ topic: 'si/topic', qos: 0 }],
    properties: { subscriptionIdentifier: 0 }
  }, { protocolVersion: 5 }))

  const [, err] = await clientError
  t.assert.match(err.message, /subscription identifier/, 'protocol error surfaced')
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x82, '0x82 Protocol Error on the wire')
})

test('MQTT 5.0 broker.close() sends DISCONNECT 0x8B to connected v5 clients', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'shutdown', reconnectPeriod: 0 })
  await once(client, 'connect')
  while (!broker.clients.shutdown?.connected) await delay(5)

  const disc = once(client, 'disconnect')
  broker.close() // teardown's close() is idempotent
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x8B, 'Server shutting down reason on the wire')
})

test('MQTT 5.0 unauthorized QoS 0 publish is dropped silently, connection stays up', async (t) => {
  t.plan(3)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizePublish: (client, packet, cb) => cb(packet.topic.startsWith('denied') ? new Error('no') : null)
    }
  })
  const sub = connect({ clientId: 'unauth0-sub' })
  await once(sub, 'connect')
  await sub.subscribeAsync('denied/+')
  let received = false
  sub.on('message', () => { received = true })

  const pub = connect({ clientId: 'unauth0-pub', reconnectPeriod: 0 })
  await once(pub, 'connect')
  // v5: an unauthorized QoS 0 publish has no ack to carry a reason code, so it is
  // dropped silently and the connection stays up (matching the QoS>0 0x87 posture)
  // while still surfacing the authz failure on clientError.
  const clientError = once(broker, 'clientError')
  await pub.publishAsync('denied/x', 'data', { qos: 0 })
  const [, err] = await clientError
  await delay(20) // short settle to confirm non-delivery (clientError already awaited)

  t.assert.ok(err, 'unauthorized publish surfaced a clientError')
  t.assert.equal(pub.connected, true, 'connection stays up')
  t.assert.equal(received, false, 'unauthorized QoS 0 message not delivered')
})

test('MQTT 5.0 broker close emits willDropped for a pending delayed will', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t)
  const willClient = connect({
    clientId: 'willdrop',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: { topic: 'willdrop/t', payload: 'x', qos: 0, properties: { willDelayInterval: 60 } }
  })
  await once(willClient, 'connect')
  while (!broker.clients.willdrop?.connected) await delay(5)

  // Closing the broker can't time the delayed will; it is dropped observably.
  const dropped = once(broker, 'willDropped')
  broker.close() // teardown's close() is idempotent
  const [client] = await dropped
  t.assert.equal(client.id, 'willdrop', 'willDropped emitted for the pending delayed will')
})

test('MQTT 5.0 pendingSessionsLimit publishes an over-cap delayed will immediately', async (t) => {
  t.plan(3)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { pendingSessionsLimit: 1 }
  })
  const watcher = connect({ clientId: 'willcap-watch' })
  await once(watcher, 'connect')
  await watcher.subscribeAsync('willcap/+')

  // First delayed will takes the single pending-will slot (stays delayed).
  const a = connect({
    clientId: 'willcap-a',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: { topic: 'willcap/a', payload: 'a', qos: 0, properties: { willDelayInterval: 60 } }
  })
  await once(a, 'connect')
  a.stream.destroy()
  while (broker.delayedWills.size < 1) await delay(5)

  // Second exceeds the cap → its will is published immediately, not queued, and
  // the trip is observable. finish() schedules the will before session-expiry,
  // so the first sessionLimitReached carries the will-delay discriminator.
  const limit = once(broker, 'sessionLimitReached')
  const got = once(watcher, 'message')
  const b = connect({
    clientId: 'willcap-b',
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 },
    will: { topic: 'willcap/b', payload: 'b', qos: 0, properties: { willDelayInterval: 60 } }
  })
  await once(b, 'connect')
  b.stream.destroy()
  const [, payload] = await got
  t.assert.equal(payload.toString(), 'b', 'over-cap delayed will published immediately')
  const [climit, info] = await limit
  t.assert.equal(climit.id, 'willcap-b', 'sessionLimitReached fired for the over-cap client')
  t.assert.equal(info.reason, 'willDelay', 'discriminator marks the will-delay path')
})

test('MQTT 5.0 oversized frame is rejected from its declared length before full buffering', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: { maximumPacketSize: 50 }
  })
  const client = connect({ clientId: 'chunked-big', reconnectPeriod: 0 })
  await once(client, 'connect')

  // Raw PUBLISH fixed header declaring a 200-byte remaining length, but only a
  // couple of payload bytes sent: the broker rejects from the declared length
  // (read-path guard) before the rest of the body arrives.
  const disc = once(client, 'disconnect')
  client.stream.write(Buffer.from([0x30, 0xC8, 0x01, 0x00, 0x03]))
  const [packet] = await disc
  t.assert.equal(packet.reasonCode, 0x95, 'rejected with 0x95 from the declared length')
})

test('MQTT 5.0 Retain Handling 2 does not send retained on subscribe', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)
  const pub = connect({ clientId: 'rh2-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('rh2/topic', 'retained', { retain: true })

  const sub = connect({ clientId: 'rh2-sub' })
  await once(sub, 'connect')
  const got = once(sub, 'message').then(() => 'message')
  await sub.subscribeAsync('rh2/topic', { qos: 0, rh: 2 })
  const result = await Promise.race([got, delay(300).then(() => 'timeout')])
  t.assert.equal(result, 'timeout', 'rh=2 suppresses retained on subscribe')
})

test('MQTT 5.0 Retain Handling 1 sends retained only for a new subscription', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)
  const pub = connect({ clientId: 'rh1-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('rh1/topic', 'retained', { retain: true })

  const sub = connect({ clientId: 'rh1-sub' })
  await once(sub, 'connect')
  // First (new) subscription with rh=1 → retained delivered.
  const first = once(sub, 'message')
  await sub.subscribeAsync('rh1/topic', { qos: 0, rh: 1 })
  const [, p1] = await first
  t.assert.equal(p1.toString(), 'retained', 'new subscription gets retained')
  // Re-subscribe (already exists) with rh=1 → no retained re-sent.
  const second = once(sub, 'message').then(() => 'message')
  await sub.subscribeAsync('rh1/topic', { qos: 0, rh: 1 })
  const result = await Promise.race([second, delay(300).then(() => 'timeout')])
  t.assert.equal(result, 'timeout', 're-subscription does not re-send retained')
})

test('MQTT 5.0 $share subscribe is refused with 0x9E (shared subs unavailable)', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'share-sub' })
  await once(client, 'connect')
  const subacks = []
  client.on('packetreceive', p => { if (p.cmd === 'suback') subacks.push(p) })
  try {
    await client.subscribeAsync('$share/grp/topic')
  } catch { /* mqtt.js rejects on a >= 0x80 SUBACK reason code */ }
  while (subacks.length === 0) await delay(5)
  t.assert.equal(subacks[0].granted?.[0], 0x9E, 'shared subscription refused with 0x9E')
  t.assert.equal(subacks[0].properties?.reasonString, 'shared subscriptions are not supported', 'SUBACK reason string [#823]')
})

test('MQTT 5.0 DISCONNECT cannot raise Session Expiry when CONNECT declared 0', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'disc-se0', clean: false, properties: { sessionExpiryInterval: 0 } })
  await once(client, 'connect')
  const clientError = once(broker, 'clientError')
  // Illegal: a non-zero Session Expiry on DISCONNECT when CONNECT declared 0.
  client.end(false, { properties: { sessionExpiryInterval: 60 } })
  const [, err] = await clientError
  t.assert.match(err.message, /Session Expiry/, 'protocol error surfaced; value ignored')
})

test('MQTT 5.0 CONNECT with an Authentication Method but no authenticateEnhanced handler is rejected with 0x8C', async (t) => {
  // No `authenticateEnhanced` configured → enhanced auth is unsupported, so a
  // CONNECT that asks for it is rejected with 0x8C (Bad authentication method).
  // This is gated on the missing handler; auth-data-without-method (below) is an
  // unconditional protocol error regardless of handler.
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t)
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'authm',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-1' }
  }, { protocolVersion: 5 }))
  const [, err] = await connErr
  t.assert.match(err.message, /no authenticateEnhanced handler is configured/, 'rejected: hook not configured, names the cause')
  await delay(20)
  t.assert.equal(received.find(p => p.cmd === 'connack')?.reasonCode, 0x8c, 'CONNACK 0x8C on the wire')
})

test('MQTT 5.0 enhanced authentication: the standard authenticate hook is chained after a successful exchange', async (t) => {
  t.plan(3)
  // A successful enhanced-auth exchange must not skip broker.authenticate — policy
  // that lives there (IP checks, setting client.user, rate limits) still runs. Here
  // authenticate runs, sets client.user, and its result gates the connection.
  let authCalled = false
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept' }) },
      authenticate (client, username, password, cb) { authCalled = true; client.user = 'chained'; cb(null, true) }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-chain',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0, 'CONNACK success')
  t.assert.equal(authCalled, true, 'the standard authenticate hook ran (chained), not skipped')
  t.assert.equal(broker.clients['ea-chain']?.user, 'chained', 'authenticate set client.user for the enhanced-auth client')
})

test('MQTT 5.0 enhanced authentication: a rejecting chained authenticate hook rejects the CONNECT', async (t) => {
  t.plan(1)
  // The chained authenticate result gates the connection: even after enhanced auth
  // proves identity, a failing authenticate hook (e.g. an IP/allow-list denial)
  // rejects with the standard 0x87 CONNACK path.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept' }) },
      authenticate (client, username, password, cb) {
        const err = new Error('denied by policy')
        err.returnCode = 5
        cb(err, false)
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-chain-deny',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, 'chained authenticate denial rejects the CONNACK')
})

test('MQTT 5.0 enhanced authentication: a two-round AUTH exchange completes the CONNECT', async (t) => {
  t.plan(7)
  const rounds = []
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        rounds.push(data?.toString())
        if (data?.toString() === 'client-first') {
          cb(null, { status: 'challenge', data: Buffer.from('server-challenge') }) // challenge
        } else if (data?.toString() === 'client-final') {
          cb(null, { status: 'accept', data: Buffer.from('server-final') }) // accept
        } else {
          cb(new Error('unexpected auth data'))
        }
      }
    }
  })

  // Raw v5 client so we drive the CONNECT + AUTH exchange by hand.
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Reply to the server's challenge with our final data.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-client',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const auth = received.find(p => p.cmd === 'auth')
  const connack = received.find(p => p.cmd === 'connack')
  // §1/§2: the continuation AUTH was dispatched (not deadlocked) and the pipeline
  // resumed to a successful CONNACK.
  t.assert.equal(auth?.reasonCode, 0x18, 'server sent AUTH 0x18 (Continue)')
  t.assert.equal(auth?.properties?.authenticationData?.toString(), 'server-challenge', 'challenge data on the AUTH')
  t.assert.equal(connack.reasonCode, 0, 'CONNACK success after the exchange')
  // [MQTT-4.12.0-5]: the successful CONNACK MUST echo the Authentication Method.
  t.assert.equal(connack.properties?.authenticationMethod, 'SCRAM-SHA-256', 'CONNACK echoes the Authentication Method')
  t.assert.equal(connack.properties?.authenticationData?.toString(), 'server-final', 'final auth data on the CONNACK')
  // §5: authenticationData is merged into (not substituted for) the capabilities.
  t.assert.equal(connack.properties?.sharedSubscriptionAvailable, false, 'CONNACK still advertises broker capabilities')
  t.assert.deepEqual(rounds, ['client-first', 'client-final'], 'the hook was called once per round')
})

test('MQTT 5.0 enhanced authentication: a single-round accept straight from CONNECT (no challenge, no data)', async (t) => {
  t.plan(7)
  let hookData = 'unset'
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        hookData = data // CONNECT carried no authenticationData → undefined
        cb(null, { status: 'accept' }) // accept immediately, no challenge, no final data
      }
    }
  })

  const ready = once(broker, 'clientReady')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-oneround',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' } // no authenticationData
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(hookData, undefined, 'hook receives undefined data when CONNECT carries none')
  t.assert.equal(received.some(p => p.cmd === 'auth'), false, 'no AUTH is emitted on a single-round accept')
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0, 'CONNACK success')
  t.assert.equal(connack.properties?.authenticationMethod, 'SCRAM-SHA-256', 'CONNACK echoes the method even with no final data')
  t.assert.equal(connack.properties?.authenticationData, undefined, 'no Authentication Data when the hook returned none')
  // Server-side state: the client is fully registered, not just ACKed on the wire.
  const [readyClient] = await ready
  t.assert.equal(readyClient.id, 'ea-oneround', 'clientReady fired → client is registered')
  // The whole-exchange deadline must be cleared on the success path — a dropped
  // clearTimeout in finishAuth would orphan an unref()'d per-connection timer that
  // process-exit checks wouldn't catch.
  t.assert.equal(readyClient._enhancedAuthTimer, null, 'the enhanced-auth timer is cleared on success')
})

test('MQTT 5.0 enhanced authentication: a non-AUTH packet mid-exchange is not processed before auth completes', async (t) => {
  t.plan(2)
  // Blocker: a client that answers a challenge with a PUBLISH (data plane) instead
  // of an AUTH must not have it processed pre-CONNACK / pre-authorization.
  let authorizedAtPublish = null
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authorizePublish (client, packet, cb) {
        authorizedAtPublish = client._authorized === true
        cb(null)
      },
      authenticateEnhanced (client, method, data, cb) {
        if (data?.toString() === 'client-first') cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
        else cb(null, { status: 'accept' })
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Reply to the challenge with a PUBLISH (its own segment) THEN the AUTH.
      raw.write(generate({ cmd: 'publish', topic: 'ea/sneak', payload: Buffer.from('x'), qos: 0 }, { protocolVersion: 5 }))
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-sneak',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  await delay(30) // let the queued PUBLISH drain post-CONNACK
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0, 'exchange still completes')
  // Either the publish was dropped, or it was processed only after authorization —
  // never as an unauthenticated pre-CONNACK action.
  t.assert.notEqual(authorizedAtPublish, false, 'a mid-exchange PUBLISH is never processed while unauthorized')
})

test('MQTT 5.0 enhanced authentication: a pre-played AUTH (pipelined before the challenge) does not burn a round', async (t) => {
  t.plan(2)
  // [Blocker] A continuation AUTH is only valid AFTER the client sees the challenge.
  // A client that pipelines CONNECT + AUTH(s) in one segment must not have those
  // pre-plays consumed as round responses — otherwise a single ~30-byte segment
  // burns every maxAuthRounds hook call at zero RTT. The pre-play is dropped; the
  // exchange stalls waiting for a real (post-challenge) response and is rejected on
  // the short deadline. The hook is invoked once (the CONNECT's round), not twice.
  let hookCalls = 0
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      connectTimeout: 200, // short so the stall rejects quickly
      authenticateEnhanced (client, method, data, cb) {
        hookCalls++
        if (data?.toString() === 'client-first') cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
        else cb(null, { status: 'accept', data: Buffer.from('server-final') })
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  // CONNECT and a pre-played continuation AUTH in a SINGLE write (one TCP segment).
  const connect = generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-pipe',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 })
  const auth = generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 })
  raw.write(Buffer.concat([connect, auth]))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, 'stalls and is rejected — the pre-play was not accepted as the response')
  t.assert.equal(hookCalls, 1, 'the hook ran once (the CONNECT round), not for the pre-played AUTH')
})

test('MQTT 5.0 enhanced authentication: a CONNECT + stray AUTH in one segment still sends the success CONNACK', async (t) => {
  t.plan(2)
  // [Blocker] With a one-round accept, a stray AUTH pipelined in the CONNECT segment
  // sits queued. The success drain must NOT route it into handleAuth's no-exchange
  // branch (which would destroy the socket, so the exchange completes with NO CONNACK
  // and `connecting` stuck true) — the queued AUTH is dropped and the CONNACK is sent.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept' }) } // accept on round 1
    }
  })
  const ready = once(broker, 'clientReady')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  const connect = generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-stray',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 })
  const stray = generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('stray') } }, { protocolVersion: 5 })
  raw.write(Buffer.concat([connect, stray]))

  const [readyClient] = await ready
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0, 'success CONNACK is sent (not a bare close)')
  // And the stray AUTH did not disconnect the now-connected client.
  await delay(30)
  t.assert.equal(broker.clients[readyClient.id] !== undefined, true, 'client stays connected (stray AUTH dropped, not a Protocol Error disconnect)')
})

test('MQTT 5.0 enhanced authentication: a hook returning non-Buffer data is rejected, not a process crash', async (t) => {
  t.plan(2)
  // [Blocker] A non-Buffer result.data (Uint8Array from crypto.subtle, null, a
  // number) would reach mqtt-packet and throw — uncaught on the CONNACK size probe
  // (process exit), the client choosing via maximumPacketSize. Validate at the
  // boundary: reject with a clientError, never serialize it.
  const brokerErrors = []
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept', data: new Uint8Array([1, 2, 3]) }) }
    }
  })
  broker.on('clientError', (c, e) => { brokerErrors.push(e.message) })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-baddata',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', maximumPacketSize: 50 }
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.ok(received.find(p => p.cmd === 'connack').reasonCode >= 0x80, 'rejected (no crash, no success)')
  t.assert.ok(brokerErrors.some(m => /must be a Buffer/.test(m)), 'clientError explains the broken hook')
})

test('MQTT 5.0 enhanced authentication: a result with an invalid status fails closed (guards the legacy { done } shape)', async (t) => {
  t.plan(2)
  // `status` is the discriminator: anything other than 'accept' / 'challenge' — a
  // typo, or a hook still returning the pre-release `{ done: true }` shape — must be
  // rejected, never guessed into an accept or a challenge loop. Pin that a stale
  // `{ done: true }` gets a failing CONNACK plus a clientError, not a silent accept.
  const brokerErrors = []
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { done: true }) } // legacy shape, no `status`
    }
  })
  broker.on('clientError', (c, e) => { brokerErrors.push(e.message) })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-badstatus',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' }
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.ok(received.find(p => p.cmd === 'connack').reasonCode >= 0x80, 'rejected (no silent accept)')
  t.assert.ok(brokerErrors.some(m => /status must be/.test(m)), 'clientError names the invalid status')
})

test('MQTT 5.0 enhanced authentication: a socket drop while the hook is pending is handled cleanly', async (t) => {
  t.plan(1)
  let release
  let onHookCalled
  const hookCalled = new Promise(resolve => { onHookCalled = resolve })
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        release = () => cb(null, { status: 'accept' }) // hold the callback
        onHookCalled()
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-drop',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  await hookCalled
  raw.destroy() // drop the connection while the hook is pending
  await delay(20)
  // Releasing the (now stale) hook result must not throw or emit anything odd.
  release()
  await delay(20)
  t.assert.equal(broker.connectedClients, 0, 'no client registered from a dropped pending exchange')
})

test('MQTT 5.0 enhanced authentication: a hook that calls back twice is latched to its first outcome', async (t) => {
  t.plan(1)
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'accept', data: Buffer.from('server-final') })
        cb(new Error('second call must be ignored')) // latched out
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-twice',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0, 'first outcome (success) wins; the second cb is ignored')
})

test('MQTT 5.0 enhanced authentication: an exchange that never settles is capped and rejected', async (t) => {
  t.plan(3)
  let hookCalls = 0
  // A small maxAuthRounds proves the cap is the configured broker option.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      maxAuthRounds: 3,
      authenticateEnhanced (client, method, data, cb) {
        hookCalls++
        cb(null, { status: 'challenge', data: Buffer.from('again') }) // never accept
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  let replies = 0
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth' && replies++ < 20) {
      // Keep answering each challenge; the broker's round cap must break the loop.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('more') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-loop',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x97, 'CONNACK 0x97 Quota exceeded once the round cap is hit (distinct from 0x87)')
  t.assert.equal(hookCalls, 3, 'hook invoked exactly maxAuthRounds times')
  // The rejection must leave no registered client (bounded, not once('close'),
  // to stay deterministic under test ordering).
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the round-cap rejection')
})

test('MQTT 5.0 enhanced authentication: a hook that challenges once then rejects on the second round sends a rejection CONNACK', async (t) => {
  t.plan(3)
  // Every other rejection test rejects on round 1; this proves a failure AFTER a
  // round has elapsed (the canonical "wrong final SCRAM proof") is clean —
  // state.rounds > 1 at rejection, correct reason code/string, no registration.
  let round = 0
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        if (++round === 1) cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
        else cb(Object.assign(new Error('bad final proof'), { reasonCode: 0x87, reasonString: 'bad final proof' }))
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-round2-reject',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x87, 'rejection reason code after a completed round')
  t.assert.equal(connack.properties?.reasonString, 'bad final proof', 'rejection reason string')
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the round-2 rejection')
})

test('MQTT 5.0 enhanced authentication: a rejecting hook sends a CONNACK with the reason code and string', async (t) => {
  t.plan(3)
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        // Reject on the first (and only) round with an explicit reason.
        cb(Object.assign(new Error('nope'), { reasonCode: 0x87, reasonString: 'bad credentials' }))
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-reject',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x87, 'CONNACK carries the hook reason code (0x87 Not authorized)')
  t.assert.equal(connack.properties?.reasonString, 'bad credentials', 'CONNACK carries the hook reason string')
  // The rejection must not leave a registered client — a leaked pre-registration
  // socket/registration is exactly the DoS this guards. (Bounded, not once('close'),
  // to stay deterministic under test ordering.)
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the rejection')
})

test('MQTT 5.0 enhanced authentication: a hook rejecting with a below-threshold reason code is clamped to 0x87', async (t) => {
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        // A misbehaving hook rejects but hands back 0x00 (SUCCESS) — below the
        // 0x80 failure threshold. It must be clamped so the CONNACK isn't
        // SUCCESS-coded on a rejection.
        cb(Object.assign(new Error('nope'), { reasonCode: 0x00 }))
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-clamp',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x87, 'below-threshold reason code clamped to 0x87 Not authorized')
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the rejection')
})

test('MQTT 5.0 enhanced authentication: a DISCONNECT during the exchange aborts it', async (t) => {
  t.plan(2)
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.from('server-challenge') }) // challenge, then wait
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Abort the exchange with a DISCONNECT instead of answering the challenge.
      raw.write(generate({ cmd: 'disconnect', reasonCode: 0x00 }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-disc',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  await once(raw, 'close')
  t.assert.ok(received.some(p => p.cmd === 'auth'), 'server challenged before the abort')
  t.assert.equal(received.some(p => p.cmd === 'connack'), false, 'no CONNACK: the exchange was aborted')
})

test('MQTT 5.0 enhanced authentication: a CONNECT+DISCONNECT pipelined in one segment aborts the exchange', async (t) => {
  t.plan(1)
  // The DISCONNECT is parked in the pre-connected queue (arrives before the
  // exchange state exists) and drained by _dispatchQueuedAuth once the exchange
  // is under way — aborting it rather than lingering until the auth timeout.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  const connect = generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-pipe-disc',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 })
  const disconnect = generate({ cmd: 'disconnect', reasonCode: 0x00 }, { protocolVersion: 5 })
  raw.write(Buffer.concat([connect, disconnect]))

  await once(raw, 'close')
  t.assert.equal(received.some(p => p.cmd === 'connack'), false, 'no CONNACK: the pipelined DISCONNECT aborted the exchange')
})

test('MQTT 5.0 enhanced authentication: a DISCONNECT while the hook is pending does not complete the exchange (no same-id eviction)', async (t) => {
  t.plan(3)
  // Blocker: the read loop is paused across a hook step, so a DISCONNECT arriving
  // mid-hook sits buffered. On hook success the exchange must NOT complete — it
  // would registerClient (evicting a live same-id session with 0x8E) and CONNACK
  // 0x00 for a client that already left. Drive Robert's repro: a live session
  // holds the clientId, then a second connection authenticates with the same id,
  // DISCONNECTs while the hook is pending, and the hook then resolves success.
  let release
  let onHookPending
  const hookPending = new Promise(resolve => { onHookPending = resolve })
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        release = () => cb(null, { status: 'accept' }) // hold until we've sent DISCONNECT
        onHookPending()
      }
    }
  })

  // A live, healthy session on clientId 'ea-victim'.
  const live = createConnection(port, 'localhost')
  t.after(() => live.destroy())
  live.on('error', () => {})
  const liveParser = createParser({ protocolVersion: 5 })
  const liveRx = []
  liveParser.on('packet', p => liveRx.push(p))
  live.on('data', d => liveParser.parse(d))
  live.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'ea-victim', clean: true, keepalive: 0 }, { protocolVersion: 5 }))
  while (!broker.clients['ea-victim']) await delay(5)

  // Second connection: same clientId, enhanced auth; DISCONNECT while hook pending.
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const rawRx = []
  parser.on('packet', p => rawRx.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-victim',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))
  await hookPending
  // DISCONNECT in a separate segment while the hook is still pending.
  raw.write(generate({ cmd: 'disconnect', reasonCode: 0x00 }, { protocolVersion: 5 }))
  await delay(40)
  release() // hook resolves success — must be discarded, the client has left
  await delay(60)

  t.assert.equal(liveRx.some(p => p.cmd === 'disconnect' && p.reasonCode === 0x8e), false, 'live session was NOT evicted (no 0x8E)')
  t.assert.equal(rawRx.some(p => p.cmd === 'connack' && p.reasonCode === 0), false, 'the departed client got no success CONNACK')
  t.assert.ok(broker.clients['ea-victim'], 'the live session is still registered')
})

test('MQTT 5.0 enhanced authentication: a pipelined CONNECT+DISCONNECT with a one-round accept does not evict a same-id session', async (t) => {
  t.plan(2)
  // [Blocker] The queued-DISCONNECT variant: CONNECT(method)+DISCONNECT in one
  // segment, hook accepts on round 1. Nothing challenges, so the DISCONNECT sits
  // in the pre-connected queue; finishAuth must drain it before completing rather
  // than register the client (evicting the live 'ea-q-victim') and CONNACK 0x00.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept' }) } // accept round 1
    }
  })

  const live = createConnection(port, 'localhost')
  t.after(() => live.destroy())
  live.on('error', () => {})
  const liveParser = createParser({ protocolVersion: 5 })
  const liveRx = []
  liveParser.on('packet', p => liveRx.push(p))
  live.on('data', d => liveParser.parse(d))
  live.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'ea-q-victim', clean: true, keepalive: 0 }, { protocolVersion: 5 }))
  while (!broker.clients['ea-q-victim']) await delay(5)

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const rawRx = []
  parser.on('packet', p => rawRx.push(p))
  raw.on('data', d => parser.parse(d))
  const connect = generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-q-victim',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 })
  const disconnect = generate({ cmd: 'disconnect', reasonCode: 0x00 }, { protocolVersion: 5 })
  raw.write(Buffer.concat([connect, disconnect]))
  await delay(60)

  t.assert.equal(liveRx.some(p => p.cmd === 'disconnect' && p.reasonCode === 0x8e), false, 'live session was NOT evicted (no 0x8E)')
  t.assert.ok(broker.clients['ea-q-victim'], 'the live session is still registered')
})

test('MQTT 5.0 a data packet arriving before CONNACK (async preConnect) is not processed if the connection is rejected', async (t) => {
  t.plan(1)
  // [Blocker] The _parsingBatch fast-path used to dispatch a PUBLISH arriving in a
  // fresh read batch during the async preConnect window, before the hook rejects —
  // unauthenticated publish into the bus. Data packets must queue until 'connected'.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      preConnect (client, packet, done) { setTimeout(() => done(new Error('denied')), 30) }
    }
  })
  let delivered = null
  broker.on('publish', (packet) => { if (packet.topic === 'pre/auth') delivered = packet.payload.toString() })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'ea-preauth', clean: true, keepalive: 0 }, { protocolVersion: 5 }))
  await delay(5) // still inside the async preConnect window
  raw.write(generate({ cmd: 'publish', topic: 'pre/auth', payload: Buffer.from('leak'), qos: 0 }, { protocolVersion: 5 }))
  await delay(80) // preConnect rejects at 30ms

  t.assert.equal(delivered, null, 'the pre-CONNACK PUBLISH was never delivered (queued, then dropped on rejection)')
})

test('MQTT 5.0 a connection torn down mid-connect-pipeline is not registered (no leaked client)', async (t) => {
  t.plan(3)
  // [Blocker] A pipelined CONNECT+DISCONNECT (or a socket drop) during the async
  // connect pipeline can run close() before registerClient. close()'s unregister is
  // gated on the client already being registered, so it finds nothing and skips —
  // then the still-pending pipeline registers a DEAD client, leaking it (a spurious
  // `client` event with no `clientDisconnect`, inflated connectedClients, a never-
  // freed socket). Model the exact precondition deterministically: an authenticate
  // hook that destroys the connection before continuing, so registerClient runs with
  // conn.destroyed = true. The registerClient guard must abort instead of registering.
  let clientEvents = 0
  let disconnectEvents = 0
  const { port, broker } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticate (client, username, password, cb) { client.conn.destroy(); cb(null, true) }
    }
  })
  broker.on('client', () => { clientEvents++ })
  broker.on('clientDisconnect', () => { disconnectEvents++ })

  for (let i = 0; i < 5; i++) {
    const raw = createConnection(port, 'localhost')
    raw.on('error', () => {})
    raw.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'leak-' + i, clean: true, keepalive: 0 }, { protocolVersion: 5 }))
    await delay(25)
  }
  await delay(120)

  t.assert.equal(clientEvents, 0, 'no client was registered for a connection destroyed mid-pipeline')
  t.assert.equal(disconnectEvents, 0, 'and so no clientDisconnect either')
  t.assert.equal(broker.connectedClients, 0, 'connectedClients not inflated by dead registrations')
})

test('MQTT 5.0 enhanced authentication: changing the Authentication Method mid-exchange is Bad Authentication Method (0x8C)', async (t) => {
  t.plan(1)
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.from('server-challenge') }) // always challenge
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // §4.12: reply with a DIFFERENT Authentication Method — must be rejected.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-1', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-switch',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x8c, 'CONNACK 0x8C Bad Authentication Method on a mid-exchange method change')
})

test('MQTT 5.0 enhanced authentication: hook Reason String + User Property ride the challenge AUTH', async (t) => {
  t.plan(3)
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        if (data?.toString() === 'client-first') {
          cb(null, { status: 'challenge', data: Buffer.from('server-challenge'), properties: { reasonString: 'continue please', userProperties: { step: '1' } } })
        } else {
          cb(null, { status: 'accept' })
        }
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-props',
    clean: true,
    keepalive: 0,
    // A generous Maximum Packet Size so the optional props still fit (exercises the
    // maxPacketSize-aware write path without dropping them).
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first'), maximumPacketSize: 1024 }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const auth = received.find(p => p.cmd === 'auth')
  t.assert.equal(auth?.reasonCode, 0x18, 'server sent AUTH 0x18 (Continue)')
  t.assert.equal(auth?.properties?.reasonString, 'continue please', 'hook Reason String rides the challenge AUTH')
  t.assert.equal(auth?.properties?.userProperties?.step, '1', 'hook User Property rides the challenge AUTH')
})

test('MQTT 5.0 enhanced authentication: hook result properties are dropped when Request Problem Information is 0', async (t) => {
  t.plan(2)
  // [MQTT-3.1.2-29]: with requestProblemInformation=0 the broker must not send a
  // Reason String / User Property on an AUTH. §3.15.2.2 also allows nothing else,
  // so a hook returning e.g. serverReference must not leak onto the wire either.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        if (data?.toString() === 'client-first') {
          cb(null, { status: 'challenge', data: Buffer.from('server-challenge'), properties: { reasonString: 'nope', serverReference: 'other:1883' } })
        } else {
          cb(null, { status: 'accept' })
        }
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-rpi0',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first'), requestProblemInformation: false }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const auth = received.find(p => p.cmd === 'auth')
  t.assert.equal(auth?.properties?.reasonString, undefined, 'no Reason String on the AUTH when RPI=0')
  t.assert.equal(auth?.properties?.serverReference, undefined, 'a non-allowlisted property is never forwarded onto the AUTH')
})

test('MQTT 5.0 enhanced authentication: a duplicated Authentication Method is a Protocol Error (0x82)', async (t) => {
  t.plan(1)
  // A repeated 0x15 property decodes to an array; it must be rejected at CONNECT,
  // not forwarded to the hook as method: string[]. §3.1.2.11.9.
  let hookCalls = 0
  const { port } = await createServerAndConnect(t, {
    brokerOptions: { authenticateEnhanced (client, method, data, cb) { hookCalls++; cb(null, { status: 'accept' }) } }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-dupmethod',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: ['SCRAM-SHA-256', 'SCRAM-SHA-256'] }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x82, 'duplicated method rejected with 0x82 (hook never reached: ' + hookCalls + ')')
})

test('MQTT 5.0 enhanced authentication: a duplicated Authentication Data on a continuation AUTH is a Protocol Error', async (t) => {
  t.plan(2)
  // [Blocker] The continuation AUTH is the packet an unauthenticated client fully
  // controls and repeats every round; it must be shape-validated too. A duplicated
  // 0x16 property decodes to a Buffer[], which must never reach the hook.
  const datas = []
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        datas.push(data)
        cb(null, { status: 'challenge', data: Buffer.from('challenge') }) // challenge, await reply
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Reply with a duplicated Authentication Data (decodes to a Buffer[]).
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: [Buffer.from('a'), Buffer.from('b')] } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-dupdata',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x82, 'malformed continuation AUTH rejected with 0x82')
  // The hook only ever saw the first (valid) round's data — never the Buffer[].
  t.assert.equal(datas.every(d => d === undefined || Buffer.isBuffer(d)), true, 'the hook never received a non-Buffer authenticationData')
})

test('MQTT 5.0 enhanced authentication: a hook reason code that is not a legal CONNACK code is clamped to 0x87', async (t) => {
  t.plan(1)
  // [Blocker · MQTT-3.2.2-8] 0x8E (Session taken over) is a real reason code but
  // not valid on CONNACK; a hook setting it must be clamped, not emitted illegally.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(Object.assign(new Error('nope'), { reasonCode: 0x8e })) // SESSION_TAKEN_OVER — illegal on CONNACK
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-badcode',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, '0x8E clamped to 0x87 (legal CONNACK code)')
})

test('MQTT 5.0 enhanced authentication: an empty-string Authentication Method reaches the hook (not a Protocol Error)', async (t) => {
  t.plan(2)
  // §3.1.2.11.9 makes omission/duplication of the method a Protocol Error, but an
  // empty-string method is neither — it is not spec-invalid, so aedes forwards it to
  // the hook (which is free to reject it). Here the hook accepts, and the CONNACK
  // must echo the (empty) Authentication Method.
  let seenMethod
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { seenMethod = method; cb(null, { status: 'accept' }) }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-emptymethod',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: '' }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0, 'empty-string method accepted (hook decided)')
  t.assert.equal(seenMethod, '', 'the hook received the empty-string method')
})

test('MQTT 5.0 enhanced authentication: a non-function authenticateEnhanced is treated as no handler (0x8C)', async (t) => {
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t)
  broker.authenticateEnhanced = true // mis-set option: not a function
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-badhook',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' }
  }, { protocolVersion: 5 }))
  const [, err] = await connErr
  await delay(20)
  t.assert.equal(received.find(p => p.cmd === 'connack')?.reasonCode, 0x8c, 'CONNACK 0x8C on the wire')
  t.assert.match(err.message, /authentication method/, 'rejected with 0x8C, hook never called')
})

test('MQTT 5.0 enhanced authentication: a hook that calls back with no result fails closed (not a challenge loop)', async (t) => {
  t.plan(1)
  // cb() / cb(null) / cb(null, null) must REJECT, not fall through to "send another
  // challenge" — the fail-open trap. Only an explicit { status: 'challenge' } continues.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null) } // no result
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-noresult',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, 'no-result hook rejected 0x87 (fail closed), not challenged')
})

test('MQTT 5.0 enhanced authentication: a hook can redirect with a Server Reference; a redirect code without one is clamped', async (t) => {
  t.plan(4)
  // The enhanced-auth rejection routes through the same redirect handling as
  // preConnect/authenticate: err.serverReference → 0x9C + Server Reference; a
  // redirect reasonCode (0x9C/0x9D) WITHOUT a serverReference is clamped to 0x87
  // (never a redirect code with no reference).
  const mode = { redirect: true }
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(mode.redirect
          ? Object.assign(new Error('go elsewhere'), { serverReference: 'other.example:1883' })
          : Object.assign(new Error('bad redirect'), { reasonCode: 0x9c })) // 0x9C but no serverReference
      }
    }
  })
  const connect = (id) => generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: id,
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 })
  const drive = (id) => new Promise(resolve => {
    const raw = createConnection(port, 'localhost')
    t.after(() => raw.destroy())
    raw.on('error', () => {})
    const parser = createParser({ protocolVersion: 5 })
    parser.on('packet', (p) => { if (p.cmd === 'connack') resolve(p) })
    raw.on('data', d => parser.parse(d))
    raw.write(connect(id))
  })

  const redirectConnack = await drive('ea-redirect')
  t.assert.equal(redirectConnack.reasonCode, 0x9c, 'redirect: CONNACK 0x9C Use another server')
  t.assert.equal(redirectConnack.properties?.serverReference, 'other.example:1883', 'carries the Server Reference')

  mode.redirect = false
  const clampConnack = await drive('ea-badredirect')
  t.assert.equal(clampConnack.reasonCode, 0x87, 'a 0x9C with no serverReference is clamped to 0x87')
  t.assert.strictEqual(clampConnack.properties?.serverReference, undefined, 'and carries no Server Reference')
})

test('MQTT 5.0 enhanced authentication: a challenge that cannot fit the client Maximum Packet Size is rejected, not sent oversize', async (t) => {
  t.plan(1)
  // [MQTT-3.1.2-24] A challenge whose mandatory method + data exceed the client's
  // Maximum Packet Size cannot be sent within the limit. aedes measures the AUTH
  // exactly (not via mqtt-packet's header-undercounting helper) and fails the
  // exchange rather than emitting an oversize AUTH the client answers with 0x95.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'challenge', data: Buffer.alloc(40, 0x41) }) }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-bigchallenge',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', maximumPacketSize: 50 } // 40B data + method > 50
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.some(p => p.cmd === 'auth'), false, 'no oversize AUTH emitted; the exchange was rejected instead')
})

test('MQTT 5.0 enhanced authentication: a large final Authentication Data is dropped from the CONNACK to fit Maximum Packet Size', async (t) => {
  t.plan(3)
  // [MQTT-3.1.2-24] The CONNACK carries hook final Authentication Data; when it would
  // exceed the client's Maximum Packet Size, aedes drops that optional field rather
  // than emit an oversize CONNACK the client MUST reject. The method + success code
  // are kept.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept', data: Buffer.alloc(200, 0x41) }) }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-mps',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', maximumPacketSize: 50 }
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0, 'CONNACK success')
  t.assert.equal(connack.properties?.authenticationMethod, 'SCRAM-SHA-256', 'method kept')
  t.assert.strictEqual(connack.properties?.authenticationData, undefined, 'oversize final data dropped to fit maximumPacketSize')
})

test('MQTT 5.0 enhanced authentication: a continuation AUTH omitting the method is a Protocol Error (0x82), not 0x8C', async (t) => {
  t.plan(1)
  // §3.15.2.2.2: omitting the Authentication Method is a Protocol Error (0x82); only
  // a *different* method is 0x8C.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'challenge', data: Buffer.from('challenge') }) }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Reply with a continuation AUTH that omits the Authentication Method.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationData: Buffer.from('final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-nomethod',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('first') }
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x82, 'omitted method → 0x82 Protocol Error')
})

test('MQTT 5.0 enhanced authentication: an exchange started while the broker is closing is rejected, not hung', async (t) => {
  t.plan(1)
  // Round-0 broker.closed: the exchange must fail (rejection CONNACK 0x88) and close,
  // not hang with no timer/CONNACK. Force it with a preConnect that closes the broker.
  const broker = await Aedes.createBroker({
    preConnect (client, packet, done) { broker.close(); done(null, true) },
    authenticateEnhanced (client, method, data, cb) { cb(null, { status: 'accept' }) }
  })
  const server = createServer((conn) => broker.handle(conn))
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  t.after(() => new Promise(resolve => server.close(resolve)))
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-closing',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256' }
  }, { protocolVersion: 5 }))
  await once(raw, 'close')
  t.assert.equal(received.find(p => p.cmd === 'connack')?.reasonCode, 0x88, 'rejected 0x88 Server unavailable, socket closed')
})

test('MQTT 5.0 enhanced authentication: the broker closing while the hook is pending rejects the exchange', async (t) => {
  t.plan(1)
  // processOutcome's broker.closed path: the hook is in flight when broker.close()
  // runs; when it calls back, the exchange fails (0x88) rather than proceeding.
  let release
  const broker = await Aedes.createBroker({
    authenticateEnhanced (client, method, data, cb) { release = () => cb(null, { status: 'accept' }); onPending() }
  })
  let onPending
  const pending = new Promise(resolve => { onPending = resolve })
  const server = createServer((conn) => broker.handle(conn))
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  t.after(() => new Promise(resolve => server.close(resolve)))
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-close-pending',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 }))
  await pending
  broker.close()
  release() // hook calls back after the broker closed
  await delay(40)
  t.assert.equal(received.find(p => p.cmd === 'connack')?.reasonCode, 0x88, 'exchange rejected 0x88 when broker closed mid-hook')
})

test('MQTT 5.0 CONNECT with a Maximum Packet Size of 0 is a Protocol Error (0x82)', async (t) => {
  t.plan(1)
  const { port } = await createServerAndConnect(t)
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'mps0',
    clean: true,
    keepalive: 0,
    properties: { maximumPacketSize: 0 }
  }, { protocolVersion: 5 }))
  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x82, 'Maximum Packet Size 0 rejected with 0x82')
})

test('MQTT 5.0 enhanced authentication: a hook rejecting with a non-Error is coerced (no TypeError)', async (t) => {
  t.plan(1)
  // onFailure assigns reasonCode/errorCode/reasonString on the error; a non-Error
  // rejection (a hook that throws a string) must be coerced first so those don't
  // TypeError. The reason code (none) clamps to 0x87.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        throw 'plain string, not an Error' // eslint-disable-line no-throw-literal
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-nonerr',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, 'non-Error rejection coerced, clamped to 0x87')
})

test('MQTT 5.0 enhanced authentication: a synchronously-throwing hook rejects the CONNECT', async (t) => {
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        throw Object.assign(new Error('boom'), { reasonCode: 0x87 })
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-throw',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x87, 'a throwing hook is contained as an auth failure')
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the rejection')
})

test('MQTT 5.0 enhanced authentication: a hook that continues then throws in the same call does not double-process', async (t) => {
  t.plan(2)
  // The catch's `if (!settled)` else-branch: a hook that calls cb (continue) and
  // THEN throws synchronously must not fail the exchange twice — the continue
  // stands, and the throw is only surfaced on clientError.
  let hookCalls = 0
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        hookCalls++
        if (hookCalls === 1) {
          cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
          throw new Error('thrown after continue') // must be swallowed (clientError)
        }
        cb(null, { status: 'accept' })
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-continue-throw',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const auths = received.filter(p => p.cmd === 'auth')
  t.assert.equal(auths.length, 1, 'the continue produced exactly one challenge AUTH (no double-processing)')
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0, 'the exchange still completed on the reply')
})

test('MQTT 5.0 enhanced authentication: an AUTH from a client that negotiated no method is a Protocol Error (0x82)', async (t) => {
  t.plan(2)
  // [MQTT-4.12.1-1]: a client whose CONNECT carried no Authentication Method must
  // not send AUTH at all — that is a Protocol Error, not a re-auth attempt.
  const { broker, port } = await createServerAndConnect(t)
  const clientError = once(broker, 'clientError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'connack') {
      // Now connected — fire a stray AUTH, having negotiated no method.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x19, properties: { authenticationMethod: 'SCRAM-SHA-256' } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect', protocolVersion: 5, clientId: 'ea-noauth', clean: true, keepalive: 0
  }, { protocolVersion: 5 }))

  const [, err] = await clientError
  t.assert.match(err.message, /unexpected AUTH/, 'stray AUTH surfaced as a client error')
  while (!received.some(p => p.cmd === 'disconnect')) await delay(5)
  const disconnect = received.find(p => p.cmd === 'disconnect')
  t.assert.equal(disconnect.reasonCode, 0x82, 'never-negotiated client gets a 0x82 Protocol Error DISCONNECT')
})

test('MQTT 5.0 enhanced authentication: N stray AUTHs in one segment are rejected once (latch)', async (t) => {
  t.plan(2)
  // The _rejectingAuth latch: multiple stray AUTHs in one TCP segment must produce
  // a single clientError + DISCONNECT, not one per packet (a write amplification).
  const { broker, port } = await createServerAndConnect(t)
  let errors = 0
  broker.on('clientError', () => { errors++ })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'connack') {
      // Three stray AUTHs in a single write (one TCP segment).
      const a = generate({ cmd: 'auth', reasonCode: 0x19, properties: { authenticationMethod: 'SCRAM-SHA-256' } }, { protocolVersion: 5 })
      raw.write(Buffer.concat([a, a, a]))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({ cmd: 'connect', protocolVersion: 5, clientId: 'ea-latch', clean: true, keepalive: 0 }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'disconnect')) await delay(5)
  await delay(40)
  t.assert.equal(errors, 1, 'a single clientError despite three stray AUTHs in one segment')
  t.assert.equal(received.filter(p => p.cmd === 'disconnect').length, 1, 'a single DISCONNECT')
})

test('MQTT 5.0 enhanced authentication: a re-auth AUTH from a client that negotiated a method is 0x83', async (t) => {
  t.plan(3)
  // A client that DID negotiate a method and completed enhanced auth is genuinely
  // re-authenticating (0x19) — not yet supported → Implementation specific error.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'accept' }) // accept in one round
      }
    }
  })
  const clientError = once(broker, 'clientError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'connack') {
      // Connected via enhanced auth — now attempt re-authentication.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x19, properties: { authenticationMethod: 'SCRAM-SHA-256' } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-reauth',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  const [, err] = await clientError
  t.assert.match(err.message, /re-authentication is not supported/, 're-auth surfaced with a distinct message')
  t.assert.equal(err.reasonCode, 0x83, 'the error carries the resolved reason code')
  while (!received.some(p => p.cmd === 'disconnect')) await delay(5)
  const disconnect = received.find(p => p.cmd === 'disconnect')
  t.assert.equal(disconnect.reasonCode, 0x83, 'a negotiated-method client gets a 0x83 Implementation specific error DISCONNECT')
})

test('MQTT 5.0 enhanced authentication: a connected client sending AUTH 0x18 (not re-auth 0x19) is a Protocol Error (0x82)', async (t) => {
  t.plan(1)
  // A client that negotiated a method but sends AUTH with a non-re-auth reason
  // code is NOT re-authenticating — it is a Protocol Error (0x82), not 0x83.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'accept' })
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'connack') {
      raw.write(generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256' } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-notreauth',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'disconnect')) await delay(5)
  const disconnect = received.find(p => p.cmd === 'disconnect')
  t.assert.equal(disconnect.reasonCode, 0x82, 'wrong reason code (not 0x19) is a Protocol Error')
})

test('MQTT 5.0 enhanced authentication: a continuation AUTH with a wrong reason code is a Protocol Error (0x82)', async (t) => {
  t.plan(1)
  // Mid-exchange the continuation must be 0x18; the correct method with a wrong
  // reason code (here 0x19) must still be rejected — the right operand of the
  // continuation guard.
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.from('server-challenge') })
      }
    }
  })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => {
    received.push(p)
    if (p.cmd === 'auth') {
      // Correct method, but reason code 0x19 instead of 0x18.
      raw.write(generate({ cmd: 'auth', reasonCode: 0x19, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-final') } }, { protocolVersion: 5 }))
    }
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-badrc',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  const connack = received.find(p => p.cmd === 'connack')
  t.assert.equal(connack.reasonCode, 0x82, 'a non-0x18 continuation AUTH is a Protocol Error')
})

test('MQTT 5.0 enhanced authentication: pipelined + dribbled AUTHs never invoke the hook concurrently', async (t) => {
  t.plan(1)
  // [Blocker regression] A single connection must never have two authenticateEnhanced
  // calls outstanding at once — overlapping calls corrupt a stateful mechanism's
  // per-step state. Drive the exact abuse: pipeline extra AUTHs into the CONNECT
  // segment (they queue) AND dribble more on the wire while an async hook is pending.
  let inflight = 0
  let maxInflight = 0
  let calls = 0
  const { port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        calls++
        const finish = calls >= 8
        // Respond asynchronously so overlapping calls would actually overlap.
        setTimeout(() => {
          inflight--
          cb(null, finish ? { status: 'accept' } : { status: 'challenge', data: Buffer.from('ch') })
        }, 20)
      }
    }
  })

  const authPkt = () => generate({ cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('c') } }, { protocolVersion: 5 })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  let dribbled = 0
  parser.on('packet', (p) => {
    // On each server challenge, dribble another AUTH on the wire (bounded).
    if (p.cmd === 'auth' && dribbled < 4) {
      dribbled++
      raw.write(authPkt())
    }
  })
  raw.on('data', d => parser.parse(d))
  // CONNECT + two AUTHs pipelined into one segment → the AUTHs are parked in the
  // pre-connected queue.
  const connect = generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-conc',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('c0') }
  }, { protocolVersion: 5 })
  raw.write(Buffer.concat([connect, authPkt(), authPkt()]))

  await delay(300)
  t.assert.equal(maxInflight, 1, 'authenticateEnhanced is never invoked concurrently for one connection')
})

test('MQTT 5.0 enhanced authentication: a hook that calls back after the deadline is surfaced, not dropped silently', async (t) => {
  t.plan(1)
  // The late callback is the only datum separating "raise connectTimeout" from "the
  // hook is wedged" — so when authenticateEnhanced calls back after the exchange
  // already timed out, emit a clientError rather than dropping it.
  let release
  let onHeld
  const held = new Promise(resolve => { onHeld = resolve })
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      connectTimeout: 80, // exchange deadline
      authenticateEnhanced (client, method, data, cb) { release = () => cb(null, { status: 'accept' }); onHeld() }
    }
  })
  const errors = []
  broker.on('clientError', (c, e) => errors.push(e.message))
  broker.on('connectionError', (c, e) => errors.push(e.message))
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-late',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 }))
  await held
  await delay(150) // let the deadline fire while the hook is held
  release() // hook calls back after the exchange already ended
  await delay(30)
  t.assert.ok(errors.some(m => /called back at round .* after the exchange had already ended/.test(m)), 'late callback surfaced on clientError/connectionError')
})

test('MQTT 5.0 enhanced authentication: a stalled exchange is closed after connectTimeout', async (t) => {
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t, {
    // Short window so the stalled-exchange timeout fires quickly.
    brokerOptions: {
      connectTimeout: 50,
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.from('server-challenge') }) // challenge, then wait forever
      }
    }
  })

  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  // Send CONNECT-with-method, receive the challenge, then never reply. The timeout
  // is routed through finishAuth (like every other rejection), so it produces a
  // rejection CONNACK (0x87) rather than a bare socket close.
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-stall',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first') }
  }, { protocolVersion: 5 }))

  while (!received.some(p => p.cmd === 'connack')) await delay(5)
  t.assert.equal(received.find(p => p.cmd === 'connack').reasonCode, 0x87, 'stalled exchange rejected (0x87) after connectTimeout')
  await delay(40)
  t.assert.equal(broker.connectedClients, 0, 'no client registered after the timeout')
})

test('MQTT 5.0 enhanced authentication: a challenge that cannot fit the client Maximum Packet Size fails cleanly (no hang)', async (t) => {
  t.plan(1)
  // [MQTT-3.1.2-25] A client advertising a tiny Maximum Packet Size that the AUTH
  // challenge can't fit must not stall the exchange until connectTimeout — the
  // write is a clean failure that tears the connection down with a clientError.
  const { broker, port } = await createServerAndConnect(t, {
    brokerOptions: {
      authenticateEnhanced (client, method, data, cb) {
        cb(null, { status: 'challenge', data: Buffer.alloc(64) }) // a challenge that won't fit maximumPacketSize: 8
      }
    }
  })
  const clientError = once(broker, 'clientError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'ea-tinymps',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-256', authenticationData: Buffer.from('client-first'), maximumPacketSize: 8 }
  }, { protocolVersion: 5 }))
  const [, err] = await clientError
  t.assert.match(err.message, /Maximum Packet Size/, 'over-size AUTH surfaced as a clean write failure')
})

test('MQTT 5.0 retained message on subscribe carries the Subscription Identifier', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)
  const pub = connect({ clientId: 'retsi-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('retsi/topic', 'retained', { retain: true })

  const sub = connect({ clientId: 'retsi-sub' })
  await once(sub, 'connect')
  const message = once(sub, 'message')
  await sub.subscribeAsync('retsi/topic', { qos: 0, properties: { subscriptionIdentifier: 7 } })
  const [, , packet] = await message
  t.assert.equal(packet.properties?.subscriptionIdentifier, 7, 'retained delivery carries the SI')
})

test('MQTT 5.0 publish with a wildcard Response Topic is rejected', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t)
  const client = connect({ clientId: 'rt-bad', reconnectPeriod: 0 })
  await once(client, 'connect')
  const clientError = once(broker, 'clientError')
  client.publish('rt/topic', 'data', { properties: { responseTopic: 'reply/+/x' } })
  const [, err] = await clientError
  t.assert.match(err.message, /Response Topic/, 'wildcard response topic rejected')
})

test('MQTT 5.0 two oversized packets in one TCP segment are rejected once (latch)', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { maximumPacketSize: 120 }
  })
  const client = connect({ clientId: 'two-big', reconnectPeriod: 0 })
  await once(client, 'connect')

  let errors = 0
  broker.on('clientError', () => { errors++ })
  // Two complete oversized PUBLISH frames in a single write: the parser emits
  // both synchronously within one parse() → handle() → rejectPacketTooLarge
  // twice. The latch must collapse them to a single clientError + DISCONNECT.
  const big = generate(
    { cmd: 'publish', topic: 'big/topic', payload: Buffer.alloc(200), qos: 0 },
    { protocolVersion: 5 }
  )
  client.stream.write(Buffer.concat([big, big]))
  await once(client, 'disconnect')
  await delay(50)
  t.assert.equal(errors, 1, 'rejected once despite two oversized frames in one segment')
})

test('MQTT 5.0 CONNECT with Authentication Data but no Method is a Protocol Error (0x82)', async (t) => {
  t.plan(2)
  const { broker, port } = await createServerAndConnect(t)
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  parser.on('packet', (p) => received.push(p))
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'authd',
    clean: true,
    keepalive: 0,
    properties: { authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 }))
  const [, err] = await connErr
  await delay(20)
  t.assert.equal(received.find(p => p.cmd === 'connack')?.reasonCode, 0x82, 'CONNACK 0x82 on the wire')
  t.assert.match(err.message, /authentication data/, 'rejected: auth data without method')
})
