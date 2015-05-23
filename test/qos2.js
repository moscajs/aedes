var test = require('tape').test
var helper = require('./helper')
var aedes = require('../')
var setup = helper.setup
var connect = helper.connect

function publish (t, s, packet, done) {
  var msgId = packet.messageId

  s.inStream.write(packet)

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, {
      cmd: 'pubrec',
      messageId: msgId,
      length: 2,
      dup: false,
      retain: false,
      qos: 0
    }, 'pubrec must match')

    s.inStream.write({
      cmd: 'pubrel',
      messageId: msgId
    })

    s.outStream.once('data', function (packet) {
      t.deepEqual(packet, {
        cmd: 'pubcomp',
        messageId: msgId,
        length: 2,
        dup: false,
        retain: false,
        qos: 2
      }, 'pubcomp must match')

      if (done) {
        done()
      }
    })
  })
}

test('publish QoS 2', function (t) {
  var s = connect(setup())
  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 2,
    messageId: 42
  }
  publish(t, s, packet, t.end.bind(t))
})

test('subscribe QoS 2', function (t) {
  var broker = aedes()
  var publisher = connect(setup(broker))
  var subscriber = connect(setup(broker))
  var toPublish = {
    cmd: 'publish',
    topic: 'hello',
    payload: new Buffer('world'),
    qos: 2,
    messageId: 42,
    dup: false,
    length: 14,
    retain: false
  }

  subscriber.inStream.write({
    cmd: 'subscribe',
    messageId: 24,
    subscriptions: [{
      topic: 'hello',
      qos: 2
    }]
  })

  subscriber.outStream.once('data', function (packet) {
    t.equal(packet.cmd, 'suback')
    t.deepEqual(packet.granted, [2])
    t.equal(packet.messageId, 24)

    publish(t, publisher, toPublish)

    subscriber.outStream.once('data', function (packet) {
      t.notEqual(packet.messageId, 42, 'messageId must differ')

      var msgId = packet.messageId
      delete packet.messageId
      delete toPublish.messageId
      t.deepEqual(packet, toPublish, 'packet must match')

      subscriber.inStream.write({
        cmd: 'pubrec',
        messageId: msgId
      })

      subscriber.outStream.once('data', function (packet) {
        subscriber.inStream.write({
          cmd: 'pubcomp',
          messageId: msgId
        })
        t.deepEqual(packet, {
          cmd: 'pubrel',
          messageId: msgId,
          length: 2,
          qos: 1,
          retain: false,
          dup: false
        }, 'pubrel must match')
        t.end()
      })
    })
  })
})
