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

// Poll `pred` until it is truthy, throwing after `ms` so a broker that stops
// delivering surfaces as a clear assertion instead of a 3-minute test timeout.
async function waitFor (pred, msg, ms = 2000) {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${msg}`)
    await delay(5)
  }
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

test('MQTT 5.0 inbound topicAliasMaximum: a non-integer / out-of-range value disables it, never enables a broken max', async (t) => {
  t.plan(3)
  // topicAliasMaximum is advertised as a Two Byte Integer in CONNACK, so a bad value
  // (a JSON-config string, a fraction, or one above 65535) must be coerced to 0
  // (disabled) — never advertised as-is, which would make mqtt-packet destroy every
  // v5 CONNACK, and never left as Infinity, which would lift resolveTopicAlias's
  // `alias > max` bound. A too-large value clamps to the int16 ceiling instead.
  const bad = async (value, label) => {
    const { connect } = await createServerAndConnect(t, { brokerOptions: { topicAliasMaximum: value } })
    const client = connect()
    const [connack] = await once(client, 'connect')
    t.assert.strictEqual(connack.properties?.topicAliasMaximum, undefined, label)
  }
  await bad('10', 'a string is not advertised')
  await bad(0.5, 'a fraction is not advertised')

  const { connect } = await createServerAndConnect(t, { brokerOptions: { topicAliasMaximum: 70000 } })
  const client = connect()
  const [connack] = await once(client, 'connect')
  t.assert.equal(connack.properties?.topicAliasMaximum, 65535, 'an over-range value clamps to the int16 ceiling')
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

test('MQTT 5.0 outbound Topic Alias: the broker aliases repeated topics to a v5 client', async (t) => {
  t.plan(5)
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  // The subscriber advertises a Topic Alias Maximum, so the broker may alias.
  const sub = connect({ clientId: 'oalias-sub', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/alias', { qos: 0 })

  const pub = connect({ clientId: 'oalias-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/alias', 'one')
  await waitFor(() => publishes.length >= 1, 'first delivery')
  await pub.publishAsync('o/alias', 'two')
  await waitFor(() => publishes.length >= 2, 'second delivery')

  // First delivery: full topic + a topic alias that registers the mapping.
  t.assert.equal(publishes[0].topic, 'o/alias', 'first PUBLISH carries the full topic')
  const alias = publishes[0].properties?.topicAlias
  t.assert.ok(alias >= 1, 'first PUBLISH assigns a topic alias')
  // Second delivery on the same topic: empty topic + the same alias.
  t.assert.equal(publishes[1].topic, '', 'second PUBLISH omits the topic')
  t.assert.equal(publishes[1].properties?.topicAlias, alias, 'second PUBLISH reuses the alias')
  t.assert.equal(publishes[1].payload.toString(), 'two', 'payload still delivered')
})

test('MQTT 5.0 outbound Topic Alias: a session takeover starts a fresh alias map, not the taken-over connection\'s', async (t) => {
  t.plan(3)
  // §3.3.2-11: Topic Alias mappings must not survive a Network Connection — not even
  // a session TAKEOVER, where the new connection RESUMES the old session's state. The
  // alias map lives on the Client (per-connection), never on the resumed session, so
  // the first PUBLISH to a previously-aliased topic on the taking-over connection must
  // carry the full topic + a freshly-assigned alias — never an empty topic referencing
  // the alias the taken-over connection established but this one never negotiated.
  //
  // Forcing a real takeover (same clientId, clean:false, overlapping) is what gives
  // this test teeth: a fresh independent connection trivially has its own map, so the
  // assertion could never fail; only the resume path could leak state if aliases were
  // ever (wrongly) stored on the session instead of the Client.
  const { broker, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const opts = { clientId: 'oalias-reset', clean: false, reconnectPeriod: 0, properties: { topicAliasMaximum: 5, sessionExpiryInterval: 60 } }

  const sub1 = connect(opts)
  await once(sub1, 'connect')
  const pubs1 = []
  sub1.on('packetreceive', p => { if (p.cmd === 'publish') pubs1.push(p) })
  await sub1.subscribeAsync('o/reset', { qos: 0 })

  const pub = connect({ clientId: 'oalias-reset-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/reset', 'one')
  await pub.publishAsync('o/reset', 'two')
  await waitFor(() => pubs1.length >= 2, 'first-connection deliveries')
  t.assert.equal(pubs1[1].topic, '', 'alias is established on the first connection (empty topic on reuse)')

  // Takeover: a second connection with the SAME clientId while the first is still
  // registered. The broker closes the old Client [MQTT-3.1.4-3] and installs the new
  // one, which resumes the session — but MUST get its own empty alias map.
  const firstClient = broker.clients['oalias-reset']
  const sub2 = connect(opts)
  await once(sub2, 'connect')
  await waitFor(() => broker.clients['oalias-reset'] && broker.clients['oalias-reset'] !== firstClient, 'new Client took over the session')
  const pubs2 = []
  sub2.on('packetreceive', p => { if (p.cmd === 'publish') pubs2.push(p) })
  // Re-subscribe on the taking-over connection (QoS 0, so nothing was queued) and
  // publish the previously-aliased topic: the fresh map re-aliases it from scratch.
  await sub2.subscribeAsync('o/reset', { qos: 0 })
  await pub.publishAsync('o/reset', 'three')
  await waitFor(() => pubs2.length >= 1, 'delivery after takeover')
  t.assert.equal(pubs2[0].topic, 'o/reset', 'first PUBLISH after takeover carries the full topic (fresh map)')
  t.assert.ok(pubs2[0].properties?.topicAlias >= 1, 'and a freshly-assigned alias')
})

test('MQTT 5.0 outbound Topic Alias: not used when the client did not advertise one', async (t) => {
  t.plan(2)
  // Broker aliasing is enabled, but the client advertises no Topic Alias Maximum,
  // so the effective max is 0 and nothing is aliased ([MQTT-3.1.2-27]).
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const sub = connect({ clientId: 'oalias-off' }) // no topicAliasMaximum ⇒ 0
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/noalias', { qos: 0 })
  const pub = connect({ clientId: 'oalias-off-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/noalias', 'one')
  await pub.publishAsync('o/noalias', 'two')
  await waitFor(() => publishes.length >= 2, 'both deliveries')
  t.assert.equal(publishes[1].topic, 'o/noalias', 'full topic kept (no aliasing)')
  t.assert.strictEqual(publishes[1].properties?.topicAlias, undefined, 'no topic alias assigned')
})

test('MQTT 5.0 outbound Topic Alias: a caller-supplied topicAlias is stripped, not forwarded (broker owns the namespace)', async (t) => {
  t.plan(3)
  // topicAlias on an outbound PUBLISH is broker-owned. A caller value (via the
  // internal client.publish()) must be scrubbed and the broker's own alias applied
  // — forwarding it verbatim desyncs the broker's table from the client's and
  // misdelivers, and can emit an alias the client never negotiated
  // ([MQTT-3.1.2-26/27]).
  const { broker, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const sub = connect({ clientId: 'oalias-caller', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  while (!broker.clients['oalias-caller']) await delay(5)
  const target = broker.clients['oalias-caller']
  // First publish carries a bogus caller alias 3 — the broker must ignore it and
  // assign its own (1) with the full topic.
  target.publish({ cmd: 'publish', topic: 'x/caller', payload: Buffer.from('one'), qos: 0, properties: { topicAlias: 3 } }, () => {})
  await waitFor(() => publishes.length >= 1, 'first delivery')
  t.assert.equal(publishes[0].topic, 'x/caller', 'full topic kept on first use')
  t.assert.equal(publishes[0].properties?.topicAlias, 1, 'broker-assigned alias 1, not the caller value 3')
  // Second publish of the same topic reuses the broker alias (empty topic + 1) —
  // proving the broker table, not the caller value, governs.
  target.publish({ cmd: 'publish', topic: 'x/caller', payload: Buffer.from('two'), qos: 0, properties: { topicAlias: 3 } }, () => {})
  await waitFor(() => publishes.length >= 2, 'second delivery')
  t.assert.equal(publishes[1].properties?.topicAlias, 1, 'reuses broker alias 1 (empty topic), caller value ignored')
})

test('MQTT 5.0 outbound Topic Alias: a full alias table falls back to the full topic, and cached aliases still resolve', async (t) => {
  t.plan(4)
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const sub = connect({ clientId: 'oalias-full', properties: { topicAliasMaximum: 1 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/#', { qos: 0 })
  const pub = connect({ clientId: 'oalias-full-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/a', '1')
  await waitFor(() => publishes.length >= 1, 'first delivery')
  await pub.publishAsync('o/b', '2') // distinct topic, but the single alias slot is taken
  await waitFor(() => publishes.length >= 2, 'second delivery')
  t.assert.equal(publishes[0].properties?.topicAlias, 1, 'first topic gets alias 1')
  t.assert.equal(publishes[1].topic, 'o/b', 'second topic sent with its full name (table full)')
  t.assert.strictEqual(publishes[1].properties?.topicAlias, undefined, 'no alias assigned once the table is full')
  // The existing mapping must still resolve once the table is full — re-publish the
  // cached topic and confirm it reuses alias 1 (empty topic), not a fresh full topic.
  await pub.publishAsync('o/a', '3')
  await waitFor(() => publishes.length >= 3, 'third delivery')
  t.assert.deepEqual(
    { topic: publishes[2].topic, alias: publishes[2].properties?.topicAlias },
    { topic: '', alias: 1 },
    'a cached topic still reuses its alias after the table filled')
})

test('MQTT 5.0 outbound Topic Alias: table exhaustion emits outboundTopicAliasExhausted once per connection', async (t) => {
  t.plan(3)
  // Silent degradation is the risk: once the per-connection table fills, further
  // distinct topics quietly revert to full-topic PUBLISHes. Emit a one-shot event so
  // an operator can spot an outboundTopicAliasMaximum set too low. Effective max here
  // is min(client 1, broker 5) = 1.
  const { broker, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const events = []
  broker.on('outboundTopicAliasExhausted', (client, info) => events.push({ id: client.id, info }))
  const sub = connect({ clientId: 'oalias-exhaust', properties: { topicAliasMaximum: 1 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('e/#', { qos: 0 })
  const pub = connect({ clientId: 'oalias-exhaust-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('e/a', '1') // fills the single slot (alias 1)
  await waitFor(() => publishes.length >= 1, 'first delivery')
  t.assert.equal(events.length, 0, 'not emitted while the table still has room')
  await pub.publishAsync('e/b', '2') // new topic, table full -> exhausted
  await pub.publishAsync('e/c', '3') // another new topic -> must NOT re-emit (latched)
  await waitFor(() => publishes.length >= 3, 'later deliveries')
  await delay(20)
  t.assert.deepEqual(events, [{ id: 'oalias-exhaust', info: { max: 1 } }], 'emitted exactly once, carrying the effective max')
  // A cached topic re-publish after exhaustion must not emit again either.
  await pub.publishAsync('e/a', '4')
  await waitFor(() => publishes.length >= 4, 'cached re-delivery')
  await delay(20)
  t.assert.equal(events.length, 1, 'still exactly one event (reusing a cached alias does not re-trip)')
})

test('MQTT 5.0 outbound Topic Alias: a client advertising above the broker cap is clamped to it', async (t) => {
  t.plan(2)
  // The broker option bounds the effective max even when the client advertises far
  // more: with outboundTopicAliasMaximum: 2 and a client advertising 100, only 2
  // aliases are assigned and the 3rd distinct topic falls back to the full name.
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 2 } })
  const sub = connect({ clientId: 'oalias-cap', properties: { topicAliasMaximum: 100 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('c/#', { qos: 0 })
  const pub = connect({ clientId: 'oalias-cap-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('c/a', '1')
  await pub.publishAsync('c/b', '2')
  await pub.publishAsync('c/c', '3') // 3rd distinct topic — beyond the broker cap of 2
  await waitFor(() => publishes.length >= 3, 'three deliveries')
  t.assert.equal(publishes[1].properties?.topicAlias, 2, 'second distinct topic still gets alias 2')
  t.assert.strictEqual(publishes[2].properties?.topicAlias, undefined, 'third falls back to the full topic (broker cap 2)')
})

test('MQTT 5.0 outbound Topic Alias: outboundTopicAliasMaximum 0 disables outbound aliasing', async (t) => {
  t.plan(2)
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 0 } })
  const sub = connect({ clientId: 'oalias-off-opt', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('d/x', { qos: 0 })
  const pub = connect({ clientId: 'oalias-off-opt-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('d/x', '1')
  await pub.publishAsync('d/x', '2')
  await waitFor(() => publishes.length >= 2, 'both deliveries')
  t.assert.equal(publishes[1].topic, 'd/x', 'full topic kept (broker disabled outbound aliasing)')
  t.assert.strictEqual(publishes[1].properties?.topicAlias, undefined, 'no alias assigned')
})

test('MQTT 5.0 outbound Topic Alias: aliasing an outbound QoS 1 PUBLISH does not poison the stored packet', async (t) => {
  t.plan(6)
  // write.js SPREADS (shallow-clones) rather than mutating. aedes-packet
  // reference-shares the `properties` object between the delivered QoSPacket and
  // the persistence-stored packet (Packet copies `topic` by value but aliases
  // `properties`), so setting `properties.topicAlias` in place on an aliased send
  // would poison the stored packet's properties. That poison is invisible on the
  // wire on any resend — an aliasing-ON reconnect OVERWRITES topicAlias with a
  // freshly-assigned value, and an aliasing-OFF reconnect SCRUBS it (see
  // withOutboundTopicAlias) — so the decisive check reads the STORED packet
  // straight out of persistence and asserts its properties were never mutated.
  //
  // We then also reconnect advertising a Topic Alias Maximum (aliasing back ON) to
  // pin the realistic resume end-to-end: a clean stored packet is the fresh map's
  // first use of 'o/q1', so it resends full topic + a freshly-assigned alias 1,
  // proving the fresh connection re-aliases from scratch rather than replaying a
  // stale empty-topic form. The publisher sends a User Property so the shared
  // `properties` object exists. §3.3.2.3.4 / see withOutboundTopicAlias.
  const { broker, port, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const connectSub = (advertiseAlias) => generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'oalias-q1',
    clean: false,
    keepalive: 0,
    properties: advertiseAlias
      ? { topicAliasMaximum: 5, sessionExpiryInterval: 60 }
      : { sessionExpiryInterval: 60 }
  }, { protocolVersion: 5 })

  // First connection: advertise a Topic Alias Maximum, subscribe, receive two
  // deliveries (second is aliased), ACK only the first, then drop the socket
  // leaving the aliased one un-acked.
  const raw1 = createConnection(port, 'localhost')
  raw1.on('error', () => {})
  const parser1 = createParser({ protocolVersion: 5 })
  const rx1 = []
  parser1.on('packet', p => {
    rx1.push(p)
    if (p.cmd === 'connack') {
      raw1.write(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'o/q1', qos: 1 }] }, { protocolVersion: 5 }))
    }
  })
  raw1.on('data', d => parser1.parse(d))
  raw1.write(connectSub(true))
  await waitFor(() => rx1.some(p => p.cmd === 'suback'), 'subscribed')

  const pub = connect({ clientId: 'oalias-q1-pub' })
  await once(pub, 'connect')
  const props = { userProperties: { k: 'v' } } // ensures packet.properties exists (reference-shared)
  await pub.publishAsync('o/q1', 'one', { qos: 1, properties: props })
  await waitFor(() => rx1.filter(p => p.cmd === 'publish').length >= 1, 'first delivery')
  // ACK the first (full-topic) delivery so only the aliased one is left pending.
  const first = rx1.find(p => p.cmd === 'publish')
  raw1.write(generate({ cmd: 'puback', messageId: first.messageId }, { protocolVersion: 5 }))
  await pub.publishAsync('o/q1', 'two', { qos: 1, properties: props })
  await waitFor(() => rx1.filter(p => p.cmd === 'publish').length >= 2, 'aliased delivery')
  const second = rx1.filter(p => p.cmd === 'publish')[1]
  t.assert.equal(second.topic, '', 'the second delivery was aliased (empty topic on the wire)')
  t.assert.ok(second.properties?.topicAlias >= 1, 'and carried a Topic Alias')

  // Drop the socket with 'two' un-acked; wait for broker-side teardown.
  raw1.destroy()
  await waitFor(() => !broker.clients['oalias-q1'], 'old Client deregistered')

  // Decisive clone check: read 'two' straight out of persistence (its properties
  // object is the very one the aliased delivery handled) and assert the aliased send
  // left it untouched — full topic, no topicAlias. An in-place mutation would show
  // properties.topicAlias === 1 here, where no resend path can mask it.
  const stored = []
  for await (const p of broker.persistence.outgoingStream({ id: 'oalias-q1' })) stored.push(p)
  const storedTwo = stored.find(p => p.payload?.toString() === 'two')
  t.assert.equal(storedTwo?.topic, 'o/q1', 'stored packet keeps its real topic (delivery did not mutate it)')
  t.assert.strictEqual(storedTwo?.properties?.topicAlias, undefined, 'stored packet carries no Topic Alias (properties not poisoned)')

  // Reconnect the persistent session, advertising a Topic Alias Maximum so outbound
  // aliasing is back ON with a fresh, empty per-connection map. The un-acked 'two'
  // is resent from storage: a clean stored packet is the fresh map's first use of
  // 'o/q1', so it resends the full topic + a freshly-assigned alias 1; a poisoned
  // stored packet is an empty-topic form whose stale alias gets scrubbed.
  const raw2 = createConnection(port, 'localhost')
  t.after(() => raw2.destroy())
  raw2.on('error', () => {})
  const parser2 = createParser({ protocolVersion: 5 })
  const rx2 = []
  parser2.on('packet', p => rx2.push(p))
  raw2.on('data', d => parser2.parse(d))
  raw2.write(connectSub(true))
  await waitFor(() => rx2.some(p => p.cmd === 'publish' && p.payload.toString() === 'two'), 'un-acked message resent')
  const resent = rx2.find(p => p.cmd === 'publish' && p.payload.toString() === 'two')
  // The topic half of the clone claim: an in-place `packet.topic = ''` mutation would
  // leave the stored packet as an empty-topic form, resent here as a zero-length topic
  // (scrubbed of its stale alias by the fresh map's passthrough). A proper clone keeps
  // the real topic, which the fresh connection re-aliases from scratch.
  t.assert.equal(resent.topic, 'o/q1', 'resent PUBLISH carries the real topic (not an empty-topic mutation)')
  t.assert.equal(resent.properties?.topicAlias, 1, 'resent PUBLISH gets a fresh alias from the new connection, not the poisoned connection-1 alias')
})

test('MQTT 5.0 outbound Topic Alias: fanout assigns distinct per-subscriber aliases; v3/v4 subscribers get none', async (t) => {
  t.plan(5)
  // Each connection keeps its OWN alias table: subA racks up an alias on a private
  // topic first, so on the shared topic subA assigns alias 2 while subB assigns
  // alias 1 — distinct, per-connection numbering. A v3/v4 subscriber never receives
  // an alias. (The clone-not-mutate invariant is pinned by the QoS 1 poison test
  // above; it isn't observable on the QoS 0 fanout path, where each subscriber
  // re-runs aliasing synchronously before its own serialize.)
  const { port, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const collect = (client) => {
    const pubs = []
    client.on('packetreceive', p => { if (p.cmd === 'publish') pubs.push(p) })
    return pubs
  }

  const subA = connect({ clientId: 'fan-a', properties: { topicAliasMaximum: 5 } })
  const subB = connect({ clientId: 'fan-b', properties: { topicAliasMaximum: 5 } })
  const subV4 = mqtt.connect({ port, host: 'localhost', protocolVersion: 4, clientId: 'fan-v4', reconnectPeriod: 0 })
  t.after(() => subV4.end(true))
  await Promise.all([once(subA, 'connect'), once(subB, 'connect'), once(subV4, 'connect')])
  const pubsA = collect(subA)
  const pubsB = collect(subB)
  const pubsV4 = collect(subV4)
  // subA also subscribes a private topic to burn alias 1 before the shared one.
  await Promise.all([
    subA.subscribeAsync('o/priv', { qos: 0 }),
    subA.subscribeAsync('o/fan', { qos: 0 }),
    subB.subscribeAsync('o/fan', { qos: 0 }),
    subV4.subscribeAsync('o/fan', { qos: 0 })
  ])

  const pub = connect({ clientId: 'fan-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/priv', 'p') // only subA — takes subA's alias 1
  await waitFor(() => pubsA.length >= 1, 'subA got the private delivery')
  await pub.publishAsync('o/fan', 'shared') // both v5 subs + the v4 sub
  await waitFor(() => pubsA.length >= 2 && pubsB.length >= 1 && pubsV4.length >= 1, 'shared delivery fanned out')

  const aFan = pubsA.find(p => p.payload.toString() === 'shared')
  // subA already used alias 1 for o/priv, so o/fan is alias 2 for subA...
  t.assert.equal(aFan.properties?.topicAlias, 2, 'sub A: o/fan is alias 2 (o/priv took alias 1)')
  // ...while subB, with a fresh table, assigns alias 1 to o/fan. Distinct values
  // prove the shared properties object was cloned, not mutated across subscribers.
  t.assert.equal(pubsB[0].properties?.topicAlias, 1, 'sub B: o/fan is alias 1 independently')
  t.assert.equal(aFan.topic, 'o/fan', 'both v5 subs carry the full topic on first use')
  // The v3/v4 subscriber must get the full topic and no alias.
  t.assert.equal(pubsV4[0].topic, 'o/fan', 'v4 sub: full topic')
  t.assert.strictEqual(pubsV4[0].properties?.topicAlias, undefined, 'v4 sub: never receives a Topic Alias')
})

test('MQTT 5.0 outbound Topic Alias: a duplicated Topic Alias Maximum in CONNECT does not crash delivery', async (t) => {
  t.plan(2)
  // §3.1.2.11.5: a repeated Topic Alias Maximum is a Protocol Error; mqtt-packet
  // decodes it to an array. That array must not reach the write path as a bogus
  // max (it would slip past two type-inconsistent guards and throw on the first
  // delivery). We disable outbound aliasing for the connection rather than crash.
  const { port, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  const parser = createParser({ protocolVersion: 5 })
  const received = []
  let onConnack, onSuback
  const gotConnack = new Promise(resolve => { onConnack = resolve })
  const gotSuback = new Promise(resolve => { onSuback = resolve })
  parser.on('packet', p => {
    received.push(p)
    if (p.cmd === 'connack') onConnack(p)
    else if (p.cmd === 'suback') onSuback()
  })
  raw.on('data', d => parser.parse(d))
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'oalias-dup',
    clean: true,
    keepalive: 0,
    properties: { topicAliasMaximum: [5, 5] }
  }, { protocolVersion: 5 }))
  const connack = await gotConnack
  t.assert.equal(connack.reasonCode, 0, 'connects despite the duplicated property')
  raw.write(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'o/dup', qos: 0 }] }, { protocolVersion: 5 }))
  await gotSuback

  const pub = connect({ clientId: 'oalias-dup-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/dup', 'hello')
  await waitFor(() => received.some(p => p.cmd === 'publish'), 'delivery arrives without crashing')
  const delivered = received.find(p => p.cmd === 'publish')
  t.assert.equal(delivered.topic, 'o/dup', 'delivered with the full topic (aliasing disabled for the bad max)')
})

test('MQTT 5.0 outbound Topic Alias: a negative Topic Alias Maximum (via preConnect) does not crash delivery', async (t) => {
  t.plan(2)
  // A preConnect hook can mutate the packet to a negative topicAliasMaximum, which
  // passed the old typeof-number guard but not write.js's `!max` — a divergent
  // predicate that crashed on first delivery. The `> 0` guard closes the class.
  const { connect } = await createServerAndConnect(t, {
    brokerOptions: {
      outboundTopicAliasMaximum: 5,
      preConnect (client, packet, done) {
        if (packet.properties) packet.properties.topicAliasMaximum = -1
        done(null, true)
      }
    }
  })
  const sub = connect({ clientId: 'oalias-neg', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/neg', { qos: 0 })
  const pub = connect({ clientId: 'oalias-neg-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/neg', 'hi')
  await waitFor(() => publishes.length >= 1, 'delivery arrives without crashing')
  t.assert.equal(publishes[0].topic, 'o/neg', 'full topic (aliasing disabled for the negative max)')
  t.assert.strictEqual(publishes[0].properties?.topicAlias, undefined, 'no alias assigned')
})

test('MQTT 5.0 outbound Topic Alias: a retained message delivered on subscribe is aliased and registers the alias', async (t) => {
  t.plan(3)
  // Retained flush-on-subscribe builds the PUBLISH outside the live-fanout path, so
  // it exercises aliasing on a differently-constructed packet (the class the QoS 1
  // poison test guards). The retained delivery is aliased (full topic + alias) and
  // registers the mapping, so a later LIVE publish of the same topic reuses it.
  const { connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const pub = connect({ clientId: 'oalias-ret-pub' })
  await once(pub, 'connect')
  await pub.publishAsync('o/ret', 'retained', { retain: true })

  const sub = connect({ clientId: 'oalias-ret-sub', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/ret', { qos: 0 })
  await waitFor(() => publishes.length >= 1, 'retained delivery')
  t.assert.equal(publishes[0].topic, 'o/ret', 'retained delivery carries the full topic')
  t.assert.ok(publishes[0].properties?.topicAlias >= 1, 'retained delivery assigns an alias')
  // A live publish of the same topic now reuses the alias the retained flush
  // registered — empty topic + the same alias number.
  const alias = publishes[0].properties.topicAlias
  await pub.publishAsync('o/ret', 'live')
  await waitFor(() => publishes.length >= 2, 'live delivery')
  t.assert.deepEqual(
    { topic: publishes[1].topic, alias: publishes[1].properties?.topicAlias },
    { topic: '', alias },
    'live publish reuses the retained delivery\'s alias (empty topic)')
})

test('MQTT 5.0 outbound Topic Alias: a Will delivered to subscribers gets a broker alias, never a client-supplied one', async (t) => {
  t.plan(3)
  // The Will PUBLISH is built outside the live-fanout path. A client can set
  // properties.topicAlias on its own Will; that value must never reach other
  // subscribers (it would hijack an alias slot in their tables — a cross-client
  // misdelivery). The broker strips it and applies its own aliasing.
  const { port, connect } = await createServerAndConnect(t, { brokerOptions: { outboundTopicAliasMaximum: 5 } })
  const sub = connect({ clientId: 'oalias-will-sub', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/will', { qos: 0 })

  // A raw client whose Will carries a bogus topicAlias, then drops ungracefully.
  const raw = createConnection(port, 'localhost')
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'oalias-willer',
    clean: true,
    keepalive: 0,
    will: { topic: 'o/will', payload: Buffer.from('the-will'), qos: 0, properties: { topicAlias: 1 } }
  }, { protocolVersion: 5 }))
  await delay(60)
  raw.destroy() // ungraceful close ⇒ Will is published
  await waitFor(() => publishes.some(p => p.payload.toString() === 'the-will'), 'will delivered')

  const will = publishes.find(p => p.payload.toString() === 'the-will')
  t.assert.equal(will.topic, 'o/will', 'the Will carries its real topic, not an empty-topic hijack')
  t.assert.ok(will.properties?.topicAlias >= 1, 'the broker assigned its own alias')
  // The bogus client alias was 1; the broker must not blindly emit alias 1 with an
  // empty topic (which would resolve to whatever the subscriber mapped to 1).
  t.assert.notStrictEqual(will.topic, '', 'never an empty topic (client alias was stripped)')
})

test('MQTT 5.0 outbound Topic Alias: a caller alias is stripped even when outbound aliasing is disabled [MQTT-3.1.2-27]', async (t) => {
  t.plan(2)
  // With outbound aliasing off (broker default), a caller/Will-supplied topicAlias
  // must NOT be forwarded — [MQTT-3.1.2-27] forbids sending any alias to a client
  // that didn't enable it. The write path scrubs it on the disabled passthrough too.
  const { broker, connect } = await createServerAndConnect(t) // outboundTopicAliasMaximum defaults to 0
  const sub = connect({ clientId: 'oalias-27-sub', properties: { topicAliasMaximum: 5 } })
  await once(sub, 'connect')
  const publishes = []
  sub.on('packetreceive', p => { if (p.cmd === 'publish') publishes.push(p) })
  await sub.subscribeAsync('o/27', { qos: 0 })
  while (!broker.clients['oalias-27-sub']) await delay(5)
  broker.clients['oalias-27-sub'].publish({ cmd: 'publish', topic: 'o/27', payload: Buffer.from('x'), qos: 0, properties: { topicAlias: 7 } }, () => {})
  await waitFor(() => publishes.length >= 1, 'delivery')
  t.assert.equal(publishes[0].topic, 'o/27', 'full topic kept')
  t.assert.strictEqual(publishes[0].properties?.topicAlias, undefined, 'stray caller alias stripped (aliasing disabled)')
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

test('MQTT 5.0 publish with a non-integer (duplicated) topic alias is rejected, not stored', async (t) => {
  t.plan(2)
  // A duplicated Topic Alias property decodes to an array; `[1,2] < 1` / `> max` are
  // both false via NaN, so without the Number.isInteger gate it would pass the range
  // check and .set() a fresh array key per PUBLISH — an unbounded inbound-map DoS
  // that bypasses topicAliasMaximum. The broker must reject it with 0x94.
  const { broker, connect } = await createServerAndConnect(t, {
    brokerOptions: { topicAliasMaximum: 5 }
  })
  const client = connect({ clientId: 'alias-nonint', reconnectPeriod: 0 })
  await once(client, 'connect')
  const brokerClient = broker.clients['alias-nonint']
  const sizeBefore = brokerClient._inboundTopicAliases.size

  const clientError = once(broker, 'clientError')
  const disc = once(client, 'disconnect')
  client.stream.write(generate(
    { cmd: 'publish', topic: 'x', payload: 'p', qos: 0, properties: { topicAlias: [1, 2] } },
    { protocolVersion: 5 }
  ))

  const [packet] = await disc
  await clientError
  t.assert.equal(packet.reasonCode, 0x94, 'non-integer topic alias rejected with 0x94')
  t.assert.equal(brokerClient._inboundTopicAliases.size, sizeBefore, 'the inbound alias map did not grow')
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

test('MQTT 5.0 CONNECT with an Authentication Method is rejected with 0x8C', async (t) => {
  t.plan(1)
  const { broker, port } = await createServerAndConnect(t)
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'authm',
    clean: true,
    keepalive: 0,
    properties: { authenticationMethod: 'SCRAM-SHA-1' }
  }, { protocolVersion: 5 }))
  const [, err] = await connErr
  t.assert.match(err.message, /authentication method/, 'rejected with bad authentication method')
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
  t.plan(1)
  const { broker, port } = await createServerAndConnect(t)
  const connErr = once(broker, 'connectionError')
  const raw = createConnection(port, 'localhost')
  t.after(() => raw.destroy())
  raw.on('error', () => {})
  raw.write(generate({
    cmd: 'connect',
    protocolVersion: 5,
    clientId: 'authd',
    clean: true,
    keepalive: 0,
    properties: { authenticationData: Buffer.from('x') }
  }, { protocolVersion: 5 }))
  const [, err] = await connErr
  t.assert.match(err.message, /authentication data/, 'rejected: auth data without method')
})
