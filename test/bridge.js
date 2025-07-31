import { test } from 'node:test'
import {
  createAndConnect,
  subscribe,
  checkNoPacket,
  nextPacket
} from './helperAsync.js'

for (const qos of [0, 1, 2]) {
  const packet = {
    qos,
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  }

  if (qos > 0) packet.messageId = 42

  test(`normal client sends a publish message and shall receive it back, qos = ${qos}`, async (t) => {
    t.plan(4)
    const s = await createAndConnect(t)
    await subscribe(t, s, 'hello', qos)

    s.inStream.write(packet)
    for await (const packet of s.outStream) {
      if (packet.cmd === 'publish') {
        t.assert.ok(true, 'got publish packet')
        break
      }
      if (packet.cmd === 'pubrec') {
        s.inStream.write({ cmd: 'pubrel', messageId: 42 })
      }
    }
  })

  test(`bridge client sends a publish message but shall not receive it back, qos = ${qos}`, async (t) => {
    t.plan(6)
    // protocolVersion 128 + 4 means mqtt 3.1.1 with bridgeMode enabled
    // https://github.com/mqttjs/mqtt-packet/blob/7f7c2ed8bcb4b2c582851d120a94e0b4a731f661/parser.js#L171
    const s = await createAndConnect(t, { connect: { clientId: 'my-client-bridge-1', bridgeMode: true } })
    await subscribe(t, s, 'hello', qos)
    s.inStream.write(packet)
    if (qos === 0) {
      t.assert.ok(true) // need two extra asserts to match QoS2
      t.assert.ok(true) // need two extra asserts to match QoS2
    }
    if (qos === 1) {
      const pkt = await nextPacket(s)
      t.assert.equal(pkt.cmd, 'puback', 'received QoS1 puback')
      t.assert.ok(true) // need an extra assert to match QoS2
    }
    if (qos === 2) {
      const pkt = await nextPacket(s)
      t.assert.equal(pkt.cmd, 'pubrec', 'received QoS2 pubRec')
      s.inStream.write({ cmd: 'pubrel', messageId: 42 })
      const pkt2 = await nextPacket(s)
      t.assert.equal(pkt2.cmd, 'pubcomp', 'received QoS2 pubcomp')
    }
    await checkNoPacket(t, s)
  })
}
