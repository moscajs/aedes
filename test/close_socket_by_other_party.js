import { test } from 'node:test'
import EventEmitter, { once } from 'node:events'
import { createServer } from 'node:net'
import {
  connect,
  createAndConnect,
  delay,
  setup,
  subscribe,
  withTimeout
} from './helperAsync.js'
import { Aedes } from '../aedes.js'
import mqtt from 'mqtt'

test('aedes is closed before client authenticate returns', async (t) => {
  t.plan(1)

  const evt = new EventEmitter()
  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      evt.emit('AuthenticateBegin', client)
      setTimeout(() => {
        done(null, true)
      }, 20)
    }
  })
  broker.on('client', () => {
    t.assert.fail('should no client registration')
  })
  broker.on('connackSent', () => {
    t.assert.fail('should no connack be sent')
  })
  broker.on('clientError', () => {
    t.assert.fail('should not error')
  })

  const s = setup(broker)

  const waitForAuthEvent = async () => {
    await once(evt, 'AuthenticateBegin')
    t.assert.equal(broker.connectedClients, 0)
    broker.close()
  }

  // run parallel
  await Promise.all([
    waitForAuthEvent(),
    withTimeout(connect(s), 0, 'connect timed out'), // connect will never finish
  ])
})

test('client is closed before authenticate returns', async (t) => {
  t.plan(1)

  const evt = new EventEmitter()
  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      evt.emit('AuthenticateBegin', client)
      setTimeout(() => {
        done(null, true)
      }, 20)
    }
  })

  t.after(() => broker.close())

  broker.on('client', () => {
    t.assert.fail('should no client registration')
  })
  broker.on('connackSent', () => {
    t.assert.fail('should no connack be sent')
  })
  broker.on('clientError', () => {
    t.assert.fail('should not error')
  })

  const s = setup(broker)

  const waitForAuthEvent = async () => {
    const [client] = await once(evt, 'AuthenticateBegin')
    t.assert.equal(broker.connectedClients, 0)
    client.close()
  }

  // run parallel
  await Promise.all([
    waitForAuthEvent(),
    // connect will never finish, but the client close will produce a null in the generator
    withTimeout(connect(s, { verifyIsConnack: false }), 10, 'connect timed out'),
  ])
})

test('client is closed before authorizePublish returns', async (t) => {
  t.plan(4)

  const evt = new EventEmitter()
  const broker = await Aedes.createBroker({
    authorizePublish: (client, packet, done) => {
      evt.emit('AuthorizePublishBegin', client)
      // simulate latency writing to persistent store.
      setTimeout(() => {
        done()
        evt.emit('AuthorizePublishEnd', client)
      }, 50)
    }
  })
  t.after(() => broker.close())

  const s = setup(broker)
  await connect(s)

  const connectionClosed = async () => {
    const [client, err] = await once(broker, 'clientError')
    t.assert.ok(client, 'client exists')
    t.assert.equal(err.message, 'connection closed', 'connection is closed')
  }

  const publishBegin = async () => {
    const [client] = await once(evt, 'AuthorizePublishBegin')
    t.assert.equal(broker.connectedClients, 1, '1 client connected')
    await delay(0) // give the eventloop some time
    client.close()
  }

  const publishEnd = async () => {
    await once(evt, 'AuthorizePublishEnd')
    t.assert.equal(broker.connectedClients, 0, 'no client connected')
  }

  const publish = () => {
    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world',
      qos: 1,
      messageId: 10,
      retain: false
    })
  }
  // run parallel
  await Promise.all([
    connectionClosed(),
    publishBegin(),
    publishEnd(),
    publish()
  ])
})

test('close client when its socket is closed', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)
  await subscribe(t, s, 'hello', 1)
  s.inStream.end()
  await once(s.client.conn, 'close')
  await delay(10)
  t.assert.equal(s.broker.connectedClients, 0, 'no connected client')
})

test('multiple clients subscribe same topic, and all clients still receive message except the closed one', async (t) => {
  t.plan(5)

  const broker = await Aedes.createBroker()
  let client2

  t.after(() => {
    client2.end()
    broker.close()
    server.close()
  })

  const server = createServer(broker.handle)
  const port = 1883
  server.listen(port)
  broker.on('clientError', () => {
    t.assert.fail('should not get clientError event')
  })

  const sameTopic = 'hello'

  // client 1
  const client1 = mqtt.connect('mqtt://localhost', { clientId: 'client1', resubscribe: false, reconnectPeriod: -1 })
  client1.on('message', () => {
    t.assert.fail('client1 receives message')
  })

  await new Promise(resolve => {
    client1.subscribe(sameTopic, { qos: 0, retain: false }, () => {
      t.assert.ok(true, 'client1 sub callback')
      // stimulate closed socket by users
      client1.stream.destroy()

      // client 2
      client2 = mqtt.connect('mqtt://localhost', { clientId: 'client2', resubscribe: false })
      client2.on('message', () => {
        t.assert.ok(true, 'client2 receives message')
        t.assert.equal(broker.connectedClients, 1)
        resolve()
      })
      client2.subscribe(sameTopic, { qos: 0, retain: false }, () => {
        t.assert.ok(true, 'client2 sub callback')

        // pubClient
        const pubClient = mqtt.connect('mqtt://localhost', { clientId: 'pubClient' })
        pubClient.publish(sameTopic, 'world', { qos: 0, retain: false }, () => {
          t.assert.ok(true, 'pubClient publish event')
          pubClient.end()
        })
      })
    })
  })
})
