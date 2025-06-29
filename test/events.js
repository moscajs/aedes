'use strict'

const { test } = require('tap')
const mqemitter = require('mqemitter')
const { setup, connect, subscribe } = require('./helper')
const { Aedes } = require('../')

test('publishes an hearbeat', function (t) {
  t.plan(2)

  Aedes.createBroker({
    heartbeatInterval: 10 // ms
  }).then((broker) => {
    t.teardown(broker.close.bind(broker))

    broker.subscribe('$SYS/+/heartbeat', function (message, cb) {
      const id = message.topic.match(/\$SYS\/([^/]+)\/heartbeat/)[1]
      t.equal(id, broker.id, 'broker id matches')
      t.same(message.payload.toString(), id, 'message has id as the payload')
      cb()
    })
  })
})

test('publishes birth', function (t) {
  t.plan(4)

  const mq = mqemitter()
  const brokerId = 'test-broker'
  const fakeBroker = 'fake-broker'
  const clientId = 'test-client'

  mq.on(`$SYS/${brokerId}/birth`, (message, cb) => {
    t.pass('broker birth received')
    t.same(message.payload.toString(), brokerId, 'message has id as the payload')
    cb()
  })

  Aedes.createBroker({
    id: brokerId,
    mq
  }).then((broker) => {
    broker.on('client', (client) => {
      t.equal(client.id, clientId, 'client connected')
      // set a fake counter on a fake broker
      process.nextTick(() => {
        broker.clients[clientId].duplicates[fakeBroker] = 42
        mq.emit({ topic: `$SYS/${fakeBroker}/birth`, payload: Buffer.from(fakeBroker) })
      })
    })

    mq.on(`$SYS/${fakeBroker}/birth`, (message, cb) => {
      process.nextTick(() => {
        t.equal(!!broker.clients[clientId].duplicates[fakeBroker], false, 'client duplicates has been resetted')
        cb()
      })
    })

    const s = connect(setup(broker), { clientId })
    t.teardown(s.broker.close.bind(s.broker))
  })
})

;['$mcollina', '$SYS'].forEach(function (topic) {
  test('does not forward $ prefixed topics to # subscription - ' + topic, function (t) {
    t.plan(4)

    Aedes.createBroker().then((broker) => {
      const s = connect(setup(broker))
      t.teardown(s.broker.close.bind(s.broker))

      subscribe(t, s, '#', 0, function () {
        s.outStream.once('data', function (packet) {
          t.fail('no packet should be received')
        })

        s.broker.mq.emit({
          cmd: 'publish',
          topic: topic + '/hello',
          payload: 'world'
        }, function () {
          t.pass('nothing happened')
        })
      })
    })
  })

  test('does not forward $ prefixed topics to +/# subscription - ' + topic, function (t) {
    t.plan(4)
    Aedes.createBroker().then((broker) => {
      const s = connect(setup(broker))
      t.teardown(s.broker.close.bind(s.broker))

      subscribe(t, s, '+/#', 0, function () {
        s.outStream.once('data', function (packet) {
          t.fail('no packet should be received')
        })

        s.broker.mq.emit({
          cmd: 'publish',
          topic: topic + '/hello',
          payload: 'world'
        }, function () {
          t.pass('nothing happened')
        })
      })
    })
  })
})

test('does not store $SYS topics to QoS 1 # subscription', function (t) {
  t.plan(3)

  Aedes.createBroker().then((broker) => {
    t.teardown(broker.close.bind(broker))

    const opts = { clean: false, clientId: 'abcde' }
    let s = connect(setup(broker), opts)

    subscribe(t, s, '#', 1, function () {
      s.inStream.end()

      s.broker.publish({
        cmd: 'publish',
        topic: '$SYS/hello',
        payload: 'world',
        qos: 1
      }, function () {
        s = connect(setup(broker), { clean: false, clientId: 'abcde' })

        s.outStream.once('data', function (packet) {
          t.fail('no packet should be received')
        })
      })
    })
  })
})

test('Emit event when receives a ping', { timeout: 2000 }, function (t) {
  t.plan(5)

  Aedes.createBroker().then((broker) => {
    t.teardown(broker.close.bind(broker))

    broker.on('ping', function (packet, client) {
      if (client && client) {
        t.equal(client.id, 'abcde')
        t.equal(packet.cmd, 'pingreq')
        t.equal(packet.payload, null)
        t.equal(packet.topic, null)
        t.equal(packet.length, 0)
      }
    })

    const s = connect(setup(broker), { clientId: 'abcde' })

    s.inStream.write({
      cmd: 'pingreq'
    })
  })
})

test('Emit event when broker closed', function (t) {
  t.plan(1)

  Aedes.createBroker().then((broker) => {
    broker.once('closed', function () {
      t.ok(true)
    })
    broker.close()
  })
})

test('Emit closed event one only when double broker.close()', function (t) {
  t.plan(4)

  Aedes.createBroker().then((broker) => {
    broker.on('closed', function () {
      t.pass('closed')
    })
    t.notOk(broker.closed)
    broker.close()
    t.ok(broker.closed)
    broker.close()
    t.ok(broker.closed)
  })
})

test('Test backpressure aedes published function', function (t) {
  t.plan(2)

  let publishCount = 10
  let count = 0
  let publisher
  Aedes.createBroker({
    published: function (packet, client, done) {
      if (client) {
        count++
        setTimeout(() => {
          publisher.end()
          done()
        })
      } else { done() }
    }
  }).then((broker) => {
    const mqtt = require('mqtt')
    const server = require('net').createServer(broker.handle)

    server.listen(0, function () {
      const port = server.address().port
      publisher = mqtt.connect({ port, host: 'localhost', clean: true, keepalive: 30 })

      function next () {
        if (--publishCount > 0) { process.nextTick(publish) }
      }

      function publish () {
        publisher.publish('test', 'payload', next)
      }

      publisher.on('connect', publish)
      publisher.on('end', function () {
        t.ok(count > publishCount)
        t.equal(publishCount, 0)
        broker.close()
        server.close()
      })
    })
  })
})

test('clear closed clients when the same clientId is managed by another broker', function (t) {
  t.plan(2)

  const clientId = 'closed-client'
  Aedes.createBroker().then((aedesBroker) => {
    t.teardown(aedesBroker.close.bind(aedesBroker))
    // simulate a closed client on the broker
    aedesBroker.clients[clientId] = { closed: true, broker: aedesBroker }
    aedesBroker.connectedClients = 1

    // simulate the creation of the same client on another broker of the cluster
    aedesBroker.publish({ topic: '$SYS/anotherbroker/new/clients', payload: clientId }, () => {
      t.equal(aedesBroker.clients[clientId], undefined) // check that the closed client was removed
      t.equal(aedesBroker.connectedClients, 0)
    })
  })
})
