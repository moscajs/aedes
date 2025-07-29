import { test } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import mqemitter from 'mqemitter'
import {
  brokerPublish,
  connect,
  createAndConnect,
  delay,
  nextPacketWithTimeOut,
  setup,
  subscribe,
  withTimeout
} from './helperAsync.js'
import { Aedes } from '../aedes.js'
import mqtt from 'mqtt'

async function brokerClose (broker) {
  return new Promise((resolve) => {
    broker.close(resolve)
  })
}

test('publishes an hearbeat', async (t) => {
  t.plan(2)

  const broker = await Aedes.createBroker({
    heartbeatInterval: 10 // ms
  })
  t.after(() => broker.close())

  await new Promise((resolve) => {
    broker.subscribe('$SYS/+/heartbeat', (message, cb) => {
      const id = message.topic.match(/\$SYS\/([^/]+)\/heartbeat/)[1]
      t.assert.equal(id, broker.id, 'broker id matches')
      t.assert.deepEqual(message.payload.toString(), id, 'message has id as the payload')
      cb()
      resolve()
    })
  })
})

test('publishes birth', async (t) => {
  t.plan(4)

  const mq = mqemitter()
  const brokerId = 'test-broker'
  const fakeBroker = 'fake-broker'
  const clientId = 'test-client'

  mq.on(`$SYS/${brokerId}/birth`, (message, cb) => {
    t.assert.ok(true, 'broker birth received')
    t.assert.deepEqual(message.payload.toString(), brokerId, 'message has id as the payload')
    cb()
  })

  const s = await createAndConnect(t, {
    broker: {
      id: brokerId,
      mq
    },
    connect: {
      clientId
    }
  })

  t.assert.equal(s.client.id, clientId, 'client connected')

  await new Promise(resolve => {
    // set a fake counter on a fake broker
    process.nextTick(() => {
      s.broker.clients[clientId].duplicates[fakeBroker] = 42
      mq.emit({ topic: `$SYS/${fakeBroker}/birth`, payload: Buffer.from(fakeBroker) })
    })

    mq.on(`$SYS/${fakeBroker}/birth`, (message, cb) => {
      process.nextTick(() => {
        t.assert.equal(!!s.broker.clients[clientId].duplicates[fakeBroker], false, 'client duplicates has been resetted')
        resolve()
        cb()
      })
    })
  })
})

for (const topic of ['$mcollina', '$SYS']) {
  test(`does not forward $ prefixed topics to # subscription - ${topic}`, async (t) => {
    t.plan(5)

    const s = await createAndConnect(t)
    await subscribe(t, s, '#', 0)

    await new Promise(resolve => {
      s.broker.mq.emit({
        cmd: 'publish',
        topic: topic + '/hello',
        payload: 'world'
      }, () => {
        t.assert.ok(true, 'nothing happened')
        resolve()
      })
    })
    const packet = await nextPacketWithTimeOut(s, 10)
    t.assert.equal(packet, null, 'no packet should be received')
  })

  test('does not forward $ prefixed topics to +/# subscription - ' + topic, async (t) => {
    t.plan(5)

    const s = await createAndConnect(t)

    await subscribe(t, s, '+/#', 0)
    await new Promise(resolve => {
      s.broker.mq.emit({
        cmd: 'publish',
        topic: topic + '/hello',
        payload: 'world'
      }, () => {
        t.assert.ok(true, 'nothing happened')
        resolve()
      })
    })
    const packet = await nextPacketWithTimeOut(s, 10)
    t.assert.equal(packet, null, 'no packet should be received')
  })
}

test('does not store $SYS topics to QoS 1 # subscription', async (t) => {
  t.plan(4)

  const opts = { connect: { clean: false, clientId: 'abcde' } }
  const s1 = await createAndConnect(t, opts)

  await subscribe(t, s1, '#', 1)
  s1.inStream.end()

  await once(s1.conn, 'close')

  await brokerPublish(s1, {
    cmd: 'publish',
    topic: '$SYS/hello',
    payload: 'world',
    qos: 1
  })

  const s2 = setup(s1.broker)
  await connect(s2, opts)

  const packet = await nextPacketWithTimeOut(s2, 10)
  t.assert.equal(packet, null, 'no packet should be received from client 2')
})

test('Emit event when receives a ping', async (t) => {
  t.plan(5)

  const clientId = 'abcde'
  const s = await createAndConnect(t, { connect: { keepalive: 1, clientId } })
  await delay(1)
  s.inStream.write({
    cmd: 'pingreq'
  })

  const [packet, client] = await once(s.broker, 'ping')

  t.assert.equal(client?.id, clientId)
  t.assert.equal(packet?.cmd, 'pingreq')
  t.assert.equal(packet?.payload, null)
  t.assert.equal(packet?.topic, null)
  t.assert.equal(packet?.length, 0)
})

test('Emit event when broker closed', async (t) => {
  t.plan(1)

  const broker = await Aedes.createBroker()
  // run parallel
  await Promise.all([
    once(broker, 'closed'),
    brokerClose(broker)
  ])
  t.assert.ok(true, 'closed event fired')
})

test('Emit closed event only once when double broker.close()', async (t) => {
  t.plan(4)

  const broker = await Aedes.createBroker()
  t.assert.ok(!broker.closed, 'broker not closed')

  const closedEvent = async (expected) => {
    const [result] = await withTimeout(once(broker, 'closed'), 10, ['timeout'])
    t.assert.equal(result, expected, `closed event ${expected || ''}`)
  }

  await Promise.all([
    closedEvent(undefined),
    broker.close()
  ])
  t.assert.ok(broker.closed, 'broker closed')
  await Promise.all([
    closedEvent('timeout'),
    broker.close()
  ])
})

test('Test backpressure aedes published function', async (t) => {
  t.plan(2)

  let publishCount = 10
  let count = 0
  let publisher
  const broker = await Aedes.createBroker({
    published: function (packet, client, done) {
      if (client) {
        count++
        setTimeout(() => {
          publisher.end()
          done()
        })
      } else { done() }
    }
  })
  t.after(() => {
    broker.close()
    server.close()
  })
  const server = createServer(broker.handle)

  await new Promise(resolve => {
    server.listen(0, () => {
      const port = server.address().port
      publisher = mqtt.connect({ port, host: 'localhost', clean: true, keepalive: 30 })

      function next () {
        if (--publishCount > 0) { process.nextTick(publish) }
      }

      function publish () {
        publisher.publish('test', 'payload', next)
      }

      publisher.on('connect', publish)
      publisher.on('end', () => {
        t.assert.ok(count > publishCount)
        t.assert.equal(publishCount, 0)
        resolve()
      })
    })
  })
})

test('clear closed clients when the same clientId is managed by another broker', async (t) => {
  t.plan(2)

  const clientId = 'closed-client'
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  // simulate a closed client on the broker
  broker.clients[clientId] = { closed: true, broker }
  broker.connectedClients = 1

  await new Promise(resolve => {
    // simulate the creation of the same client on another broker of the cluster
    broker.publish({ topic: '$SYS/anotherbroker/new/clients', payload: clientId }, () => {
      t.assert.equal(broker.clients[clientId], undefined) // check that the closed client was removed
      t.assert.equal(broker.connectedClients, 0)
      resolve()
    })
  })
})
