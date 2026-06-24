import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, createConnection } from 'node:net'
import mqtt from 'mqtt'
import { generate } from 'mqtt-packet'
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

  // The abrupt drop schedules the delayed will.
  await delay(150)
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
  t.assert.ok(remaining > 0 && remaining <= 60, `remaining lifetime carried (${remaining}s)`)
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
  t.assert.ok(remaining > 0 && remaining <= 60, `retained delivered with remaining lifetime (${remaining}s)`)
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
  await delay(150)

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
  await delay(150)

  t.assert.equal(pub.connected, true, 'publisher connection stays alive')
  t.assert.equal(received, false, 'unauthorized message not delivered')
  t.assert.ok(acks.some(a => a.reasonCode === 0x87), 'PUBREC carried 0x87 Not authorized')
})

test('MQTT 5.0 returns an Assigned Client Identifier for an empty clientId', async (t) => {
  t.plan(1)
  const { connect } = await createServerAndConnect(t)
  const client = connect({ clientId: '' })
  const [connack] = await once(client, 'connect')
  t.assert.ok(
    connack.properties?.assignedClientIdentifier,
    'broker returned an assigned client identifier'
  )
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

test('MQTT 5.0 broker clamps a requested Session Expiry Interval to maximumSessionExpiryInterval', async (t) => {
  t.plan(1)
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { maximumSessionExpiryInterval: 30 }
  })
  const client = connect({
    clientId: 'clamp-se',
    clean: false,
    properties: { sessionExpiryInterval: 0xFFFFFFFF } // "never" — must be clamped
  })
  await once(client, 'connect')
  // Wait until the broker has fully registered the server-side client.
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

  // Drop the connection so the will is scheduled (but not yet published).
  willClient.stream.destroy()
  await delay(150)
  t.assert.equal(broker.delayedWills.size, 1, 'delayed will is pending')

  // Closing the broker must clear the pending will timer (no leaked timer). The
  // helper's teardown close() is idempotent, so closing here as well is safe.
  await new Promise(resolve => broker.close(resolve))
  t.assert.equal(broker.delayedWills.size, 0, 'pending will cleared on close')
})
