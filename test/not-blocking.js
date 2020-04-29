'use strict'

const { test } = require('tap')
const mqtt = require('mqtt')
const net = require('net')
const Faketimers = require('@sinonjs/fake-timers')
const aedes = require('../')

test('connect 200 concurrent clients', function (t) {
  t.plan(3)

  const broker = aedes()
  const server = net.createServer(broker.handle)
  const total = 200

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.tearDown(clock.reset.bind(clock))

    const port = server.address().port

    var connected = 0
    var clients = []
    clock.setTimeout(function () {
      t.equal(clients.length, total)
      t.equal(connected, total)
      for (var i = 0; i < clients.length; i++) {
        clients[i].end()
      }
      broker.close()
      server.close()
    }, total)

    for (var i = 0; i < total; i++) {
      clients[i] = mqtt.connect({
        port: port,
        keepalive: 0
      }).on('connect', function () {
        connected++
        if ((connected % (total / 10)) === 0) {
          console.log('connected', connected)
        }
        clock.tick(1)
      }).on('error', function () {
        clock.tick(1)
      })
    }
  })
})

test('do not block after a subscription', function (t) {
  t.plan(3)

  const broker = aedes()
  const server = net.createServer(broker.handle)
  const total = 10000
  var sent = 0
  var received = 0

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.tearDown(clock.reset.bind(clock))

    const clockId = clock.setTimeout(finish, total)

    const port = server.address().port

    const publisher = mqtt.connect({
      port: port,
      keepalive: 0
    }).on('error', function (err) {
      clock.clearTimeout(clockId)
      t.fail(err)
    })

    var subscriber

    function immediatePublish () {
      setImmediate(publish)
    }

    function publish () {
      if (sent === total) {
        publisher.end()
      } else {
        sent++
        publisher.publish('test', 'payload', immediatePublish)
      }
    }

    function startSubscriber () {
      subscriber = mqtt.connect({
        port: port,
        keepalive: 0
      }).on('error', function (err) {
        if (err.code !== 'ECONNRESET') {
          clock.clearTimeout(clockId)
          t.fail(err)
        }
      })

      subscriber.subscribe('test', publish)

      subscriber.on('message', function () {
        if (received % (total / 10) === 0) {
          console.log('sent / received', sent, received)
        }
        received++
        clock.tick(1)
      })
    }

    publisher.on('connect', startSubscriber)

    function finish () {
      subscriber.end()
      publisher.end()
      broker.close()
      server.close()
      t.equal(total, sent, 'messages sent')
      t.equal(total, received, 'messages received')
    }
  })
})

test('do not block with overlapping subscription', function (t) {
  t.plan(3)

  const broker = aedes({ concurrency: 15 })
  const server = net.createServer(broker.handle)
  const total = 10000
  var sent = 0
  var received = 0

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.tearDown(clock.reset.bind(clock))

    const clockId = clock.setTimeout(finish, total)

    const port = server.address().port

    const publisher = mqtt.connect({
      port: port,
      keepalive: 0
    }).on('error', function (err) {
      clock.clearTimeout(clockId)
      t.fail(err)
    })

    var subscriber

    function immediatePublish (e) {
      setImmediate(publish)
    }

    function publish () {
      if (sent === total) {
        publisher.end()
      } else {
        sent++
        publisher.publish('test', 'payload', immediatePublish)
      }
    }

    function startSubscriber () {
      subscriber = mqtt.connect({
        port: port,
        keepalive: 0
      }).on('error', function (err) {
        if (err.code !== 'ECONNRESET') {
          clock.clearTimeout(clockId)
          t.fail(err)
        }
      })

      subscriber.subscribe('#', function () {
        subscriber.subscribe('test', function () {
          immediatePublish()
        })
      })

      subscriber.on('message', function () {
        if (received % (total / 10) === 0) {
          console.log('sent / received', sent, received)
        }
        received++
        clock.tick(1)
      })
    }

    publisher.on('connect', startSubscriber)

    function finish () {
      subscriber.end()
      publisher.end()
      broker.close()
      server.close()
      t.equal(total, sent, 'messages sent')
      t.equal(total, received, 'messages received')
    }
  })
})
