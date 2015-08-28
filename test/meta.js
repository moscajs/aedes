'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect

test('count connected clients', function (t) {
  t.plan(4)

  var broker = aedes()

  t.equal(broker.connectedClients, 0, 'no connected clients')

  connect(setup(broker))

  t.equal(broker.connectedClients, 1, 'one connected clients')

  var last = connect(setup(broker))

  t.equal(broker.connectedClients, 2, 'two connected clients')

  last.conn.destroy()

  // needed because destroy() will do the trick before
  // the next tick
  process.nextTick(function () {
    t.equal(broker.connectedClients, 1, 'one connected clients')
  })
})
