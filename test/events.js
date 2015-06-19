'use strict'

var test = require('tape').test
var aedes = require('../')

test('publishes an hearbeat', function (t) {
  t.plan(3)
  var broker = aedes({
    heartbeatInterval: 10 // ms
  })

  broker.subscribe('$SYS/+/heartbeat', function (message, cb) {
    var id = message.topic.match(/\$SYS\/([^/]+)\/heartbeat/)[1]
    t.equal(id, broker.id, 'broker id matches')
    t.deepEqual(message.payload.toString(), id, 'message has id as the payload')
    broker.close(t.pass.bind(t, 'broker closes'))
  })
})
