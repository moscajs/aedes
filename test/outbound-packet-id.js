import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createAndConnect, subscribe, nextPacket } from './helper.js'

// Regression tests for GHSA-4f66-hmm8-75r2: the outbound Packet Identifier
// counter wraps from 65535 back to 1 without checking whether an identifier is
// still in flight, so a non-acknowledging client eventually receives a new
// message carrying a Packet Identifier it never confirmed. The fix tracks
// outbound identifiers that are in flight and never reuses them.

test('outbound Packet Identifier is tracked in flight until acknowledged', async (t) => {
  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 1)

  // Publish QoS 1 to a topic this client is subscribed to. The broker acks the
  // inbound publish, then forwards the message to the subscriber (same client)
  // with a broker-assigned Packet Identifier.
  s.inStream.write({ cmd: 'publish', topic: 'hello', payload: 'x', qos: 1, messageId: 7 })
  const puback = await nextPacket(s)
  t.assert.equal(puback.cmd, 'puback')

  const delivered = await nextPacket(s)
  t.assert.equal(delivered.cmd, 'publish')
  t.assert.equal(delivered.qos, 1)
  const pid = delivered.messageId
  t.assert.ok(pid >= 1 && pid <= 65535, 'a valid Packet Identifier is assigned')
  t.assert.ok(s.client._outgoingInFlight.has(pid), 'the assigned id is tracked in flight')

  // Acknowledge, then the id must be released so it can be reused later.
  s.inStream.write({ cmd: 'puback', messageId: pid })
  await delay(20)
  t.assert.ok(!s.client._outgoingInFlight.has(pid), 'the id is released after acknowledgement')
})

test('outbound Packet Identifier allocator does not reuse an in-flight id', async (t) => {
  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 1)

  // Force the immediate next candidate to be treated as in flight.
  const forced = s.client._nextId
  s.client._outgoingInFlight.add(forced)

  s.inStream.write({ cmd: 'publish', topic: 'hello', payload: 'x', qos: 1, messageId: 8 })
  await nextPacket(s) // puback for the inbound publish
  const delivered = await nextPacket(s)

  t.assert.notEqual(delivered.messageId, forced, 'does not reuse an in-flight Packet Identifier')
  t.assert.equal(s.client._outgoingInFlight.has(delivered.messageId), true, 'the fresh id is tracked')
  t.assert.equal(s.client._outgoingInFlight.has(forced), true, 'the forced id remains in flight')
})

test('drops the connection when the whole Packet Identifier space is exhausted', async (t) => {
  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 1)

  // Occupy every possible Packet Identifier so the allocator has no free slot.
  for (let i = 1; i <= 65535; i++) {
    s.client._outgoingInFlight.add(i)
  }

  const errP = once(s.broker, 'clientError')
  s.inStream.write({ cmd: 'publish', topic: 'hello', payload: 'x', qos: 1, messageId: 9 })

  const [, err] = await errP
  t.assert.match(err.message, /outgoing Packet Identifier space exhausted/i)
})
