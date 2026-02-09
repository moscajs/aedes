import { test } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import mqtt from 'mqtt'
import { Aedes } from '../aedes.js'

test('connect 500 concurrent clients', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker({ drainTimeout: 0 }) // Disable for high-load test
  const server = createServer(broker.handle)
  t.after(() => {
    broker.close()
    server.close()
  })
  const total = 500

  server.on('error', (err) => {
    console.log('server error', err)
  })
  await new Promise(resolve => {
    server.listen(0, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const port = server.address().port

  let connected = 0
  const clients = []

  // start at 1 to see the total in the console.log
  for (let i = 1; i <= total; i++) {
    clients[i] = await mqtt.connectAsync({
      port,
      keepalive: 0
    })
    if ((i % (total / 10)) === 0) {
      console.log('connected', i)
    }
  }
  // check to see if they are all still alive
  // and end them
  for (let i = 1; i <= total; i++) {
    if (clients[i].connected) {
      connected++
    }
    await clients[i].endAsync(true)
  }
  t.assert.equal(clients.length, total + 1) // because we start at 1
  t.assert.equal(connected, total)
})

for (const [title, brokerOpts, subscription] of
  [
    ['after a subscription', {}, 'test'],
    ['with overlapping subscription', { concurrency: 15 }, ['#', 'test']]
  ]) {
  test(`do not block ${title}`, async (t) => {
    t.plan(3)

    const broker = await Aedes.createBroker({ ...brokerOpts, drainTimeout: 0 }) // Disable for high-throughput test
    const server = createServer(broker.handle)
    t.after(() => {
      broker.close()
      server.close()
    })
    const total = 10000
    let sent = 0
    let received = 0

    await new Promise(resolve => {
      server.listen(0, err => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
    const port = server.address().port
    let publisher = null

    const publish = () => {
      if (sent === total) {
        publisher.end()
        // Node 20 on Mac needs more time to complete
        // hence the setImmediate
        setImmediate(() => subscriber.end())
      } else {
        sent++
        publisher.publish('test', 'payload', () => setImmediate(publish))
      }
    }

    const subscriber = await mqtt.connectAsync({
      port,
      keepalive: 0,
      clientId: 'subscriber'
    })

    subscriber.on('error', err => {
      t.assert.fail(err)
    })

    subscriber.on('message', () => {
      if (received % (total / 10) === 0) {
        console.log('sent / received', sent, received)
      }
      received++
    })
    subscriber.subscribeAsync(subscription)

    publisher = await mqtt.connectAsync({
      port,
      keepalive: 0,
      clientId: 'publisher'
    })
    publisher.on('error', err => {
      t.assert.fail(err)
    })
    publish()

    await once(subscriber, 'close')
    t.assert.equal(total, sent, 'messages sent')
    t.assert.equal(total, received, 'messages received')
  })
}
