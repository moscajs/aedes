import { test } from 'node:test'
import { Aedes } from '../aedes.js'
import { setup } from './helper.js'

test('client queue limit emits connectionError when publish packets overflow queue', { skip: false }, async (t) => {
  t.plan(2)

  const queueLimit = 1
  const broker = await Aedes.createBroker({
    queueLimit,
    authenticate (client, username, password, callback) {
      setTimeout(() => callback(null, true), 50)
    }
  })
  t.after(() => broker.close())

  const publishP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }

  const connectP = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcde',
    keepalive: 0
  }

  const s = setup(broker)

  await new Promise((resolve) => {
    broker.once('connectionError', (client, err) => {
      t.assert.equal(err.message, 'Client queue limit reached', 'Queue overflow raises connectionError')
      t.assert.equal(client._parser._queue.length, queueLimit, 'Only queueLimit packets are queued')
      s.conn.destroy()
      resolve()
    })

    s.inStream.write(connectP)
    s.inStream.write(publishP)
    s.inStream.write(publishP)
  })
})
