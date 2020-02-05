'use strict'

const { test } = require('tap')
const { setup, connect, subscribe } = require('./helper')
const aedes = require('../')

test('publishes an hearbeat', function (t) {
  t.plan(2)

  const broker = aedes({
    heartbeatInterval: 10 // ms
  })
  t.tearDown(broker.close.bind(broker))

  broker.subscribe('$SYS/+/heartbeat', function (message, cb) {
    const id = message.topic.match(/\$SYS\/([^/]+)\/heartbeat/)[1]
    t.equal(id, broker.id, 'broker id matches')
    t.deepEqual(message.payload.toString(), id, 'message has id as the payload')
  })
})

;['$mcollina', '$SYS'].forEach(function (topic) {
  test('does not forward $ prefixed topics to # subscription - ' + topic, function (t) {
    t.plan(4)

    const s = connect(setup())
    t.tearDown(s.broker.close.bind(s.broker))

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

  test('does not forward $ prefixed topics to +/# subscription - ' + topic, function (t) {
    t.plan(4)

    const s = connect(setup())
    t.tearDown(s.broker.close.bind(s.broker))

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

test('does not store $SYS topics to QoS 1 # subscription', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const opts = { clean: false, clientId: 'abcde' }
  var s = connect(setup(broker), opts)

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

test('Emit event when receives a ping', { timeout: 2000 }, function (t) {
  t.plan(5)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

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

test('Emit event when broker closed', function (t) {
  t.plan(1)

  const broker = aedes()
  broker.once('closed', function () {
    t.ok(true)
  })
  broker.close()
})

test('Test backpressure aedes published function', { timeout: 500 }, function (t) {
  t.plan(1)

  const broker = aedes({
    published: function (packet, client, done) {
      if (client) {
        t.pass('published')
        setTimeout(done, 1000)
      } else { done() }
    }
  })
  t.tearDown(() => {
    client.end()
    broker.close()
    server.close()
  })

  const mqtt = require('mqtt')
  const server = require('net').createServer(broker.handle)
  var client

  server.listen(0, function () {
    const port = server.address().port
    client = mqtt.connect({ port: port, host: 'localhost', clean: true, keepalive: 30 })

    var count = 10

    function immediatePublish () {
      if (count) { setImmediate(publish) }
    }

    function publish () {
      count--
      client.publish('test', 'payload', immediatePublish)
    }

    client.on('connect', publish)
  })
})
