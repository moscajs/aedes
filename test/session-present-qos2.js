import { test } from 'node:test'
import assert from 'node:assert'
import { Aedes } from '../aedes.js'
import {
  connect,
  createAndConnect,
  nextPacket,
  publish,
  setup,
  subscribe
} from './helper.js'

test('Session Present is 1 for a clean=false client with retained inbound QoS2 state', async (t) => {
  const s1 = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = s1.broker

  // send an inbound QoS2 PUBLISH but do NOT complete with PUBREL
  s1.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'x',
    qos: 2,
    messageId: 1,
    retain: false,
    dup: false
  })
  const pubrec = await nextPacket(s1)
  assert.equal(pubrec.cmd, 'pubrec', 'expected PUBREC')
  assert.equal(pubrec.messageId, 1, 'PUBREC messageId')

  // hang up, leaving the QoS2 transaction unfinished
  s1.inStream.end()

  // reconnect with the same clientId, clean=false
  const s2 = setup(broker)
  const connack = await connect(s2, { connect: { clean: false, clientId: 'abcde' } })
  assert.equal(connack.sessionPresent, true, 'SESSION PRESENT should be true (inbound QoS2 state retained)')

  // the retained state must still complete: PUBREL -> PUBCOMP
  s2.inStream.write({ cmd: 'pubrel', messageId: 1 })
  const pubcomp = await nextPacket(s2)
  assert.equal(pubcomp.cmd, 'pubcomp', 'expected PUBCOMP')
  assert.equal(pubcomp.messageId, 1, 'PUBCOMP messageId')
})

test('Session Present is 0 once all inbound QoS2 state has been acknowledged', async (t) => {
  const s1 = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = s1.broker
  // complete the QoS2 handshake (PUBLISH -> PUBREC -> PUBREL -> PUBCOMP)
  await publish(t, s1, { cmd: 'publish', topic: 'hello', payload: 'x', qos: 2, messageId: 1 })
  s1.inStream.end()

  const s2 = setup(broker)
  const connack = await connect(s2, { connect: { clean: false, clientId: 'abcde' } })
  assert.equal(connack.sessionPresent, false, 'SESSION PRESENT should be false (no retained QoS2 state)')
})

test('Session Present is 0 for a clean=true reconnect even with retained inbound QoS2', async (t) => {
  const s1 = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = s1.broker
  s1.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'x',
    qos: 2,
    messageId: 1,
    retain: false,
    dup: false
  })
  const pubrec = await nextPacket(s1)
  assert.equal(pubrec.cmd, 'pubrec', 'expected PUBREC')
  s1.inStream.end()

  // a clean=true reconnect must not report a previous session
  const s2 = setup(broker)
  const connack = await connect(s2, { connect: { clean: true, clientId: 'abcde' } })
  assert.equal(connack.sessionPresent, false, 'SESSION PRESENT should be false for a clean session')
})

test('Session Present is 0 for a brand-new clean=false client', async (t) => {
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  const s = setup(broker)
  const connack = await connect(s, { connect: { clean: false, clientId: 'brandnew' } })
  assert.equal(connack.sessionPresent, false, 'SESSION PRESENT should be false for a brand-new client')
})

test('Session Present is 1 for a clean=false client with retained subscriptions', async (t) => {
  const s1 = await createAndConnect(t, { connect: { clean: false, clientId: 'abcde' } })
  const broker = s1.broker
  await subscribe(t, s1, 'hello', 0)
  s1.inStream.end()

  const s2 = setup(broker)
  const connack = await connect(s2, { connect: { clean: false, clientId: 'abcde' } })
  assert.equal(connack.sessionPresent, true, 'SESSION PRESENT should be true (subscriptions retained)')
})
