'use strict'

var { test } = require('tap')
var { setup, connect, subscribe } = require('./helper')
var aedes = require('../')

test('publishes an hearbeat', function (t) {
  t.plan(2)

  var broker = aedes({
    heartbeatInterval: 10 // ms
  })
  t.tearDown(broker.close.bind(broker))

  broker.subscribe('$SYS/+/heartbeat', function (message, cb) {
    var id = message.topic.match(/\$SYS\/([^/]+)\/heartbeat/)[1]
    t.equal(id, broker.id, 'broker id matches')
    t.deepEqual(message.payload.toString(), id, 'message has id as the payload')
  })
})

;['$mcollina', '$SYS'].forEach(function (topic) {
  test('does not forward $ prefixed topics to # subscription - ' + topic, function (t) {
    t.plan(4)

    var s = connect(setup())
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

    var s = connect(setup())
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

  var broker = aedes()
  t.tearDown(broker.close.bind(broker))

  var opts = { clean: false, clientId: 'abcde' }
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

  var broker = aedes()
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

  var s = connect(setup(broker), { clientId: 'abcde' })

  s.inStream.write({
    cmd: 'pingreq'
  })
})

test('Emit event when broker closed', function (t) {
  t.plan(1)

  var broker = aedes()
  broker.once('closed', function () {
    t.ok(true)
  })
  broker.close()
})
