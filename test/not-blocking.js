import { test } from 'node:test'
import { createServer } from 'node:net'
import mqtt from 'mqtt'
import { Aedes } from '../aedes.js'

test('connect 500 concurrent clients', async (t) => {
  t.plan(3)

  const broker = await Aedes.createBroker()
  const server = createServer(broker.handle)
  t.after(() => {
    broker.close()
    server.close()
  })
  const total = 500

  await new Promise(resolve => {
    server.listen(0, (err) => {
      t.assert.ok(!err, 'no error')
      const port = server.address().port

      let connected = 0
      const clients = []

      const registerClient = (client) => {
        clients.push(client)
        connected++
        if ((connected % (total / 10)) === 0) {
          console.log('connected', connected)
        }
        if (clients.length === total) {
          t.assert.equal(clients.length, total)
          t.assert.equal(connected, total)
          while (clients.length) {
            clients.shift().end()
          }
        }
      }

      const deRegisterClient = () => {
        connected--
        if (connected === 0) {
          resolve()
        }
      }

      const doConnect = () => {
        const client = mqtt.connect({
          port,
          keepalive: 0
        })
        client.on('connect', () => {
          registerClient(client)
        })
        client.on('error', err => {
          throw (err)
        })
        client.on('close', () => {
          deRegisterClient()
        })
      }

      for (let i = 0; i < total; i++) {
        doConnect()
      }
    })
  })
})

for (const [title, brokerOpts, subscription] of
  [
    ['after a subscription', {}, 'test'],
    ['with overlapping subscription', { concurrency: 15 }, ['#', 'test']]
  ]) {
  test(`do not block ${title}`, async (t) => {
    t.plan(3)

    const broker = await Aedes.createBroker(brokerOpts)
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

        const port = server.address().port

        let publisher

        const finish = () => {
          if (publisher.connected || subscriber.connected) { return }
          t.assert.equal(total, sent, 'messages sent')
          t.assert.equal(total, received, 'messages received')
          resolve()
        }

        const publish = () => {
          if (sent === total) {
            publisher.end()
          } else {
            sent++
            publisher.publish('test', 'payload', () => setImmediate(publish))
          }
        }

        const startPublisher = () => {
          publisher = mqtt.connect({
            port,
            keepalive: 0
          })
          publisher.on('error', err => {
            t.assert.fail(err)
          })
          publisher.on('close', () => {
            subscriber.end()
          })
          publisher.on('connect', publish)
        }

        const subscriber = mqtt.connect({
          port,
          keepalive: 0
        }).on('error', err => {
          t.assert.fail(err)
        })
        subscriber.on('connect', () => {
          subscriber.on('message', () => {
            if (received % (total / 10) === 0) {
              console.log('sent / received', sent, received)
            }
            received++
          })
          subscriber.subscribe(subscription, startPublisher)
        })
        subscriber.on('close', () => {
          finish()
        })
      })
    })
  })
}
