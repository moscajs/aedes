'use strict'

var eos = require('end-of-stream')
var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect
var noError = helper.noError

test('supports pingreq/pingresp', function (t) {
  t.plan(1)

  var s = noError(connect(setup()), t)

  s.inStream.write({
    cmd: 'pingreq'
  })

  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'pingresp', 'the response is a pingresp')
  })
})

test('supports keep alive disconnections', function (t) {
  t.plan(2)
  t.timeoutAfter(2000)

  var s = connect(setup(null, 2000), { keepalive: 1 })
  var start = Date.now()

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 1500, 'waits 1 and a half the keepalive timeout')
    t.pass('ended')
  })
})

test('supports keep alive disconnections after a pingreq', function (t) {
  t.plan(2)
  t.timeoutAfter(3000)

  var s = connect(setup(null, 3000), { keepalive: 1 })
  var start

  setTimeout(function () {
    start = Date.now()
    s.inStream.write({
      cmd: 'pingreq'
    })
  }, 1000)

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 1500, 'waits 1 and a half the keepalive timeout')
    t.pass('ended')
  })
})

test('disconnect if a connect does not arrive in time', function (t) {
  t.plan(2)
  t.timeoutAfter(500)

  var s = setup(aedes({
    connectTimeout: 100
  }))
  var start = Date.now()

  eos(s.conn, function () {
    t.ok(Date.now() >= start + 100, 'waits waitConnectTimeout before ending')
    t.pass('ended')
  })
})
