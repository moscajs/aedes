import { test } from 'node:test'
import { once } from 'node:events'
import { Aedes } from '../aedes.js'
import {
  createAndConnect,
  delay,
  nextPacket,
  setup,
} from './helper.js'

test('supports pingreq/pingresp', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t)

  s.broker.on('keepaliveTimeout', client => {
    t.assert.fail('keep alive should not timeout')
  })

  s.inStream.write({
    cmd: 'pingreq'
  })

  const packet = await nextPacket(s)
  t.assert.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
})

test('supports keep alive disconnections', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t, { connect: { keepalive: 1 } })
  await once(s.broker, 'keepaliveTimeout')
  t.assert.ok(true, 'keep alive timeout', 'timeout was triggered')
  t.assert.ok(s.client.conn.closed, 'waits 1 and a half the keepalive timeout')
})

test('supports keep alive disconnections after a pingreq', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t, { connect: { keepalive: 1 } })
  await delay(1)
  s.inStream.write({
    cmd: 'pingreq'
  })
  const packet = await nextPacket(s)
  t.assert.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
  await once(s.broker, 'keepaliveTimeout')
  t.assert.ok(true, 'keep alive timeout', 'timeout was triggered')
  t.assert.ok(s.client.conn.closed, 'waits 1 and a half the keepalive timeout')
})

test('disconnect if a connect does not arrive in time', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker({
    connectTimeout: 500
  })

  const s = setup(broker)
  t.after(() => broker.close())

  const [err] = await once(s.client, 'error')
  t.assert.equal(err.message, 'connect did not arrive in time')
  t.assert.ok(s.client.conn.closed, 'waits waitConnectTimeout before ending')
})
