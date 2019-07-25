'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var subscribe = helper.subscribe

test('close client when its socket is closed', function (t) {
  t.plan(4)

  var broker = aedes()
  var subscriber = connect(setup(broker, false))

  subscribe(t, subscriber, 'hello', 1, function () {
    subscriber.inStream.end()
    subscriber.conn.on('close', function () {
      t.equal(broker.connectedClients, 0, 'no connected client')
      broker.close()
      t.end()
    })
  })
})

test('multiple clients subscribe same topic, and all clients still receive message except the closed one', function (t) {
  t.plan(5)

  var mqtt = require('mqtt')
  var broker = aedes()
  var server = require('net').createServer(broker.handle)
  var port = 1883
  server.listen(port)
  broker.on('clientError', function (client, err) {
    t.error(err)
  })

  var client1, client2
  var _sameTopic = 'hello'

  // client 1
  client1 = mqtt.connect('mqtt://localhost', { clientId: 'client1', resubscribe: false, reconnectPeriod: -1 })
  client1.on('message', () => {
    t.fail('client1 receives message')
  })

  client1.subscribe(_sameTopic, { qos: 0, retain: false }, () => {
    t.pass('client1 sub callback')
    // stimulate closed socket by users
    client1.stream.destroy()

    // client 2
    client2 = mqtt.connect('mqtt://localhost', { clientId: 'client2', resubscribe: false })
    client2.on('message', () => {
      t.pass('client2 receives message')
    })
    client2.subscribe(_sameTopic, { qos: 0, retain: false }, () => {
      t.pass('client2 sub callback')

      // pubClient
      var pubClient = mqtt.connect('mqtt://localhost', { clientId: 'pubClient' })
      pubClient.publish(_sameTopic, 'world', { qos: 0, retain: false }, () => {
        t.pass('pubClient publish event')
        pubClient.end()
      })
    })
  })
  setTimeout(() => {
    t.equal(broker.connectedClients, 1)
    client2.end()
    broker.close()
    server.close()
  }, 2000)
})
