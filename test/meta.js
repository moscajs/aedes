'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

test('count connected clients', function (t) {
  t.plan(4)

  var broker = aedes()

  t.equal(broker.connectedClients, 0, 'no connected clients')

  connect(setup(broker))

  t.equal(broker.connectedClients, 1, 'one connected clients')

  var last = connect(setup(broker))

  t.equal(broker.connectedClients, 2, 'two connected clients')

  last.conn.destroy()

  // needed because destroy() will do the trick before
  // the next tick
  process.nextTick(function () {
    t.equal(broker.connectedClients, 1, 'one connected clients')
  })
})

test('call published method', function (t) {
  t.plan(4)

  var broker = aedes()

  broker.published = function (packet, client, done) {
    t.equal(packet.topic, 'hello', 'topic matches')
    t.equal(packet.payload.toString(), 'world', 'payload matches')
    t.equal(client, null, 'no client')
    broker.close()
    done()
  }

  broker.publish({
    topic: 'hello',
    payload: new Buffer('world')
  }, function (err) {
    t.error(err, 'no error')
  })
})

test('emit publish event', function (t) {
  t.plan(4)

  var broker = aedes()

  broker.on('publish', function (packet, client) {
    t.equal(packet.topic, 'hello', 'topic matches')
    t.equal(packet.payload.toString(), 'world', 'payload matches')
    t.equal(client, null, 'no client')
    broker.close()
  })

  broker.publish({
    topic: 'hello',
    payload: new Buffer('world')
  }, function (err) {
    t.error(err, 'no error')
  })
})

test('emit subscribe event', function (t) {
  t.plan(6)

  var broker = aedes()
  var s = connect(setup(broker), { clientId: 'abcde' })

  broker.on('subscribe', function (subscriptions, client) {
    t.deepEqual(subscriptions, [{
      topic: 'hello',
      qos: 0
    }], 'topic matches')
    t.equal(client.id, 'abcde', 'client matches')
  })

  subscribe(t, s, 'hello', 0, function () {
    t.pass('subscribe completed')
  })
})
