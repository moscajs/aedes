'use strict'

var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect

test('publish direct to a single client QoS 0', function (t) {
  t.plan(2)

  var broker = aedes()
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  broker.on('newClient', function (client) {
    client.publish({
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 0
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('publish direct to a single client QoS 1', function (t) {
  t.plan(2)

  var broker = aedes()
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }

  broker.on('newClient', function (client) {
    client.publish({
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    expected.messageId = packet.messageId
    t.deepEqual(packet, expected, 'packet matches')
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  })
})

test('offline message support for direct publish', function (t) {
  t.plan(2)

  var broker = aedes()
  var expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }
  var opts = {
    clean: false,
    clientId: 'abcde'
  }

  broker.once('newClient', function (client) {
    client.publish({
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  var s = connect(setup(broker), opts)

  s.outStream.once('data', function (packet) {
    s = connect(setup(broker), opts)

    s.outStream.once('data', function (packet) {
      s = connect(setup(broker), opts)
      s.inStream.write({
        cmd: 'puback',
        messageId: packet.messageId
      })
      delete packet.messageId
      t.deepEqual(packet, expected, 'packet must match')
    })
  })
})
