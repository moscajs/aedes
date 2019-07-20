'use strict'

var test = require('tape').test
var helper = require('./helper')
var setup = helper.setup
var connect = helper.connect

test('after an error, outstanding packets are discarded', function (t) {
  t.plan(1)
  var s = connect(setup(), {
    keepalive: 1000
  })
  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  }

  s.broker.mq.on('hello', function (msg, cb) {
    t.pass('first msg received')
    s.inStream.destroy(new Error('something went wrong'))
    cb()
    setImmediate(() => {
      packet.topic = 'foo'
      s.inStream.write(packet)
      s.inStream.write(packet)
    })
  })
  s.broker.mq.on('foo', function (msg, cb) {
    t.fail('msg received')
  })
  s.inStream.write(packet)
})
