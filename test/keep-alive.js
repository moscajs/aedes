'use strict'

const { test } = require('tap')
const eos = require('end-of-stream')
const { setup, connect, noError } = require('./helper')
const aedes = require('../')

test('supports pingreq/pingresp', function (t) {
  t.plan(1)

  const s = noError(connect(setup()))
  t.tearDown(s.broker.close.bind(s.broker))

  s.inStream.write({
    cmd: 'pingreq'
  })

  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
  })
})

test('supports keep alive disconnections', { timeout: 2000 }, function (t) {
  t.plan(1)

  const start = Date.now()
  const s = connect(setup(), { keepalive: 1 })
  t.tearDown(s.broker.close.bind(s.broker))

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 1500, 'waits 1 and a half the keepalive timeout')
  })
})

test('supports keep alive disconnections after a pingreq', { timeout: 3000 }, function (t) {
  t.plan(1)

  const s = connect(setup(), { keepalive: 1 })
  t.tearDown(s.broker.close.bind(s.broker))

  var start

  setTimeout(function () {
    start = Date.now()
    s.inStream.write({
      cmd: 'pingreq'
    })
  }, 1000)

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 1500, 'waits 1 and a half the keepalive timeout')
  })
})

test('disconnect if a connect does not arrive in time', { timeout: 1000 }, function (t) {
  t.plan(1)

  const start = Date.now()
  const s = setup(aedes({
    connectTimeout: 500
  }))
  t.tearDown(s.broker.close.bind(s.broker))

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 500, 'waits waitConnectTimeout before ending')
  })
})
