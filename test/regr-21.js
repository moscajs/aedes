'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var aedesConfig = {}
var setup = helper.setup
var connect = helper.connect

test('after an error, outstanding packets are discarded', function (t) {
  t.plan(1)

  var broker = aedes(aedesConfig)
  var s = connect(setup(broker), {
    keepalive: 1000
  })
  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  }

  s.broker.mq.on('hello', function (msg, cb) {
    t.pass('first msg received')
    s.inStream.emit('error', new Error('something went wrong'))
    setImmediate(cb)
  })

  s.inStream.write(packet)
  setImmediate(function () {
    s.inStream.write(packet)
    s.inStream.write(packet)
  })
})
