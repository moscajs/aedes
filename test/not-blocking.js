'use strict'

const { test } = require('tap')
const EventEmitter = require('events')
const mqtt = require('mqtt')
const net = require('net')
const Faketimers = require('@sinonjs/fake-timers')
const aedes = require('../')

test('connect 500 concurrent clients', function (t) {
  t.plan(3)

  const evt = new EventEmitter()
  const broker = aedes()
  const server = net.createServer(broker.handle)
  const total = 500

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.teardown(clock.reset.bind(clock))

    const port = server.address().port

    let connected = 0
    const clients = []
    clock.setTimeout(function () {
      t.equal(clients.length, total)
      t.equal(connected, total)
      while (clients.length) {
        clients.shift().end()
      }
    }, total)

    evt.on('finish', function () {
      if (clients.length === 0) {
        broker.close()
        server.close()
      }
    })

    for (let i = 0; i < total; i++) {
      clients[i] = mqtt.connect({
        port,
        keepalive: 0,
        reconnectPeriod: 100
      }).on('connect', function () {
        connected++
        if ((connected % (total / 10)) === 0) {
          console.log('connected', connected)
        }
        clock.tick(1)
      }).on('close', function () {
        evt.emit('finish')
      })
    }
  })
})

test('do not block after a subscription', function (t) {
  t.plan(3)

  const evt = new EventEmitter()
  const broker = aedes()
  const server = net.createServer(broker.handle)
  const total = 10000
  let sent = 0
  let received = 0

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.teardown(clock.reset.bind(clock))

    const clockId = clock.setTimeout(finish, total)

    const port = server.address().port

    const publisher = mqtt.connect({
      port,
      keepalive: 0
    }).on('error', function (err) {
      clock.clearTimeout(clockId)
      t.fail(err)
    })

    let subscriber

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
        port,
        keepalive: 0
      }).on('error', function (err) {
        clock.clearTimeout(clockId)
        t.fail(err)
      })

      subscriber.subscribe('test', publish)

      subscriber.on('message', function () {
        if (received % (total / 10) === 0) {
          console.log('sent / received', sent, received)
        }
        received++
        clock.tick(1)
      })
      subscriber.on('close', function () {
        evt.emit('finish')
      })
    }

    publisher.on('connect', startSubscriber)
    publisher.on('close', function () {
      evt.emit('finish')
    })
    evt.on('finish', function () {
      if (publisher.connected || subscriber.connected) { return }
      broker.close()
      server.close()
      t.equal(total, sent, 'messages sent')
      t.equal(total, received, 'messages received')
    })
    function finish () {
      subscriber.end()
      publisher.end()
    }
  })
})

test('do not block with overlapping subscription', function (t) {
  t.plan(3)

  const evt = new EventEmitter()
  const broker = aedes({ concurrency: 15 })
  const server = net.createServer(broker.handle)
  const total = 10000
  let sent = 0
  let received = 0

  server.listen(0, function (err) {
    t.error(err, 'no error')

    const clock = Faketimers.createClock()
    t.teardown(clock.reset.bind(clock))

    const clockId = clock.setTimeout(finish, total)

    const port = server.address().port

    const publisher = mqtt.connect({
      port,
      keepalive: 0
    }).on('error', function (err) {
      clock.clearTimeout(clockId)
      t.fail(err)
    })

    let subscriber

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
        port,
        keepalive: 0
      }).on('error', function (err) {
        clock.clearTimeout(clockId)
        t.fail(err)
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
      subscriber.on('close', function () {
        evt.emit('finish')
      })
    }

    publisher.on('connect', startSubscriber)
    publisher.on('close', function () {
      evt.emit('finish')
    })
    evt.on('finish', function () {
      if (publisher.connected || subscriber.connected) { return }
      broker.close()
      server.close()
      t.equal(total, sent, 'messages sent')
      t.equal(total, received, 'messages received')
    })
    function finish () {
      subscriber.end()
      publisher.end()
    }
  })
})
