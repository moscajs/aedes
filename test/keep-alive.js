'use strict'

const { test } = require('tap')
const eos = require('end-of-stream')
const Faketimers = require('@sinonjs/fake-timers')
const { setup, connect, noError } = require('./helper')
const aedes = require('../')

test('supports pingreq/pingresp', function (t) {
  t.plan(1)

  const s = noError(connect(setup()))
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('keepaliveTimeout', function (client) {
    t.fail('keep alive should not timeout')
  })

  s.inStream.write({
    cmd: 'pingreq'
  })

  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
  })
})

test('supports keep alive disconnections', function (t) {
  t.plan(2)

  const clock = Faketimers.install()
  const s = connect(setup(), { keepalive: 1 })
  t.teardown(s.broker.close.bind(s.broker))

  s.broker.on('keepaliveTimeout', function (client) {
    t.pass('keep alive timeout')
  })
  eos(s.conn, function () {
    t.pass('waits 1 and a half the keepalive timeout')
  })

  setTimeout(() => {
    clock.uninstall()
  }, 1.5)
  clock.tick(1.5)
})

test('supports keep alive disconnections after a pingreq', function (t) {
  t.plan(3)

  const clock = Faketimers.install()
  const s = connect(setup(), { keepalive: 1 })
  t.teardown(s.broker.close.bind(s.broker))

  eos(s.conn, function () {
    t.pass('waits 1 and a half the keepalive timeout')
  })
  s.broker.on('keepaliveTimeout', function (client) {
    t.pass('keep alive timeout')
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
  })
  setTimeout(() => {
    s.inStream.write({
      cmd: 'pingreq'
    })
    clock.uninstall()
  }, 1)
  clock.tick(3)
})

test('disconnect if a connect does not arrive in time', function (t) {
  t.plan(2)

  const clock = Faketimers.install()
  const s = setup(aedes({
    connectTimeout: 500
  }))
  t.teardown(s.broker.close.bind(s.broker))

  s.client.on('error', function (err) {
    t.equal(err.message, 'connect did not arrive in time')
  })
  eos(s.conn, function () {
    t.pass('waits waitConnectTimeout before ending')
  })
  setTimeout(() => {
    clock.uninstall()
  }, 1000)
  clock.tick(1000)
})
