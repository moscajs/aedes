'use strict'

var test = require('tape').test
var EE = require('events').EventEmitter
var handle = require('../../lib/handlers/index')

test('reject clients with no clientId running on MQTT 3.1', function (t) {
  t.plan(2)

  var client = new EE()
  var broker = {
    registerClient: function () {}
  }

  client.broker = broker
  client.conn = {
    destroy: function () {
      t.fail('should not destroy')
    }
  }

  client.on('error', function (err) {
    t.equal(err.message, 'Empty clientIds are supported only on MQTT 3.1.1', 'error message')
  })

  handle(client, {
    cmd: 'connect',
    protocolVersion: 3,
    protocolId: 'MQIsdp'
  }, function (err) {
    t.error(err, 'no error in callback')
  })
})
