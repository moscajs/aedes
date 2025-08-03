import { test } from 'node:test'
import {
  createAndConnect,
  withTimeout
} from './helperAsync.js'

test('after an error, outstanding packets are discarded', async (t) => {
  t.plan(2)
  const s = await createAndConnect(t, {
    keepalive: 1000
  })

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  }

  const checkFoo = async () => {
    const result = await withTimeout(
      new Promise(resolve => {
        s.broker.mq.on('foo', (msg, cb) => {
          resolve('msg received')
        })
      }),
      100,
      'timeout'
    )
    t.assert.equal(result, 'timeout', 'no msg received')
  }

  const processHello = new Promise(resolve => {
    s.broker.mq.on('hello', (msg, cb) => {
      t.assert.ok(true, 'first msg received')
      s.inStream.destroy()
      cb()
      setImmediate(() => {
        packet.topic = 'foo'
        s.inStream.write(packet)
        s.inStream.write(packet)
        resolve()
      })
    })
  })

  // run parallel
  await Promise.all([
    checkFoo(),
    processHello,
    s.inStream.write(packet)
  ])
})
