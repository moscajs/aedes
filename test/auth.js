'use strict'

var test = require('tape').test
var Client = require('../lib/client')
var helper = require('./helper')
var aedes = require('../')
var eos = require('end-of-stream')
var setup = helper.setup
var connect = helper.connect
var noError = helper.noError

test('authenticate successfully a client with username and password', function (t) {
  t.plan(4)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, new Buffer('my pass'), 'password is there')
    cb(null, true)
  }

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    username: 'my username',
    password: 'my pass',
    keepalive: 0
  })

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 0,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'successful connack')
  })
})

test('authenticate unsuccessfully a client with username and password', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, new Buffer('my pass'), 'password is there')
    cb(null, false)
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 5,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack')
  })

  eos(s.outStream, function () {
    t.pass('ended')
  })

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    username: 'my username',
    password: 'my pass',
    keepalive: 0
  })
})

test('authenticate errors', function (t) {
  t.plan(5)

  var s = setup()

  s.broker.authenticate = function (client, username, password, cb) {
    t.ok(client instanceof Client, 'client is there')
    t.equal(username, 'my username', 'username is there')
    t.deepEqual(password, new Buffer('my pass'), 'password is there')
    cb(new Error('this should happen!'))
  }

  s.outStream.on('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'connack',
      returnCode: 4,
      length: 2,
      qos: 0,
      retain: false,
      dup: false,
      topic: null,
      payload: null,
      sessionPresent: false
    }, 'unsuccessful connack')
  })

  eos(s.outStream, function () {
    t.pass('ended')
  })

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    username: 'my username',
    password: 'my pass',
    keepalive: 0
  })
})
