'use strict'

var test = require('tape')
var EE = require('events').EventEmitter
var handleConnect = require('../../lib/handlers/connect')

test('reject clients with no clientId running on MQTT 3.1', function (t) {
  t.plan(2)

  var client = new EE()
  var broker = {
    registerClient: function () {}
  }

  client.broker = broker

  client.on('error', function (err) {
    t.equal(err.message, 'Empty clientIds are supported only on MQTT 3.1.1', 'error message')
  })

  handleConnect(client, {
    protocolVersion: 3,
    protocolId: 'MQIsdp'
  }, function (err) {
    t.error(err, 'no error in callback')
  })
})
