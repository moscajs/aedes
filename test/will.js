'use strict'

var test = require('tape').test
var helper = require('./helper')
var setup = helper.setup
var connect = helper.connect

function willConnect (s, opts, connected) {
  opts = opts || {}
  opts.will = {
    topic: 'mywill',
    payload: new Buffer('last will'),
    qos: 0,
    retain: false
  }

  return connect(s, opts, connected)
}

test('delivers a will', function (t) {
  var opts = {}
  // willConnect populates opts with a will
  var s = willConnect(setup(), opts)

  s.broker.mq.on('mywill', function (packet) {
    t.equal(packet.topic, opts.will.topic, 'topic matches')
    t.deepEqual(packet.payload, opts.will.payload, 'payload matches')
    t.equal(packet.qos, opts.will.qos, 'qos matches')
    t.equal(packet.retain, opts.will.retain, 'retain matches')
    t.end()
  })

  s.conn.destroy()
})
