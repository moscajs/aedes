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

  broker.on('client', function (client) {
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

  broker.on('client', function (client) {
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

test('emit a `ack` event on PUBACK for QoS 1', function (t) {
  t.plan(6)

  var broker = aedes()
  var messageId
  var clientId

  broker.on('client', function (client) {
    clientId = client.id
    client.publish({
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    t.equal(client.id, clientId)
    t.equal(packet.messageId, messageId)
    t.equal(packet.topic, 'hello')
    t.equal(packet.payload.toString(), 'world')
    t.pass('got the ack event')
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    messageId = packet.messageId
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  })
})

test('emit a `ack` event on PUBCOMP for QoS 2', function (t) {
  t.plan(6)

  var broker = aedes()
  var messageId
  var clientId

  broker.on('client', function (client) {
    clientId = client.id
    client.publish({
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 2
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  broker.once('ack', function (packet, client) {
    t.equal(client.id, clientId)
    t.equal(packet.messageId, messageId)
    t.equal(packet.topic, 'hello')
    t.equal(packet.payload.toString(), 'world')
    t.pass('got the ack event')
  })

  var s = connect(setup(broker))

  s.outStream.on('data', function (packet) {
    if (packet.cmd === 'publish') {
      s.inStream.write({
        cmd: 'pubrec',
        messageId: packet.messageId
      })
    } else {
      messageId = packet.messageId
      s.inStream.write({
        cmd: 'pubcomp',
        messageId: packet.messageId
      })
    }
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

  broker.once('client', function (client) {
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

test('subscribe a client programmatically', function (t) {
  t.plan(3)

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

  broker.on('client', function (client) {
    client.subscribe({
      topic: 'hello',
      qos: 0
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: new Buffer('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('subscribe a client programmatically multiple topics', function (t) {
  t.plan(3)

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

  broker.on('client', function (client) {
    client.subscribe([{
      topic: 'hello',
      qos: 0
    }, {
      topic: 'aaa',
      qos: 0
    }], function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: new Buffer('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('subscribe a client programmatically with full packet', function (t) {
  t.plan(3)

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

  broker.on('client', function (client) {
    client.subscribe({
      subscriptions: [{
        topic: 'hello',
        qos: 0
      }, {
        topic: 'aaa',
        qos: 0
      }]
    }, function (err) {
      t.error(err, 'no error')

      broker.publish({
        topic: 'hello',
        payload: new Buffer('world'),
        qos: 0
      }, function (err) {
        t.error(err, 'no error')
      })
    })
  })

  var s = connect(setup(broker))

  s.outStream.once('data', function (packet) {
    t.deepEqual(packet, expected, 'packet matches')
  })
})

test('get message when client connects', function (t) {
  t.plan(2)
  var client1 = 'gav'
  var broker = aedes()

  broker.on('client', function (client) {
    client.subscribe({
      subscriptions: [{
        topic: '$SYS/+/new/clients',
        qos: 0
      }]
    }, function (err) {
      t.error(err, 'no error')
    })
  })

  var s1 = connect(setup(broker), { clientId: client1 })

  s1.outStream.on('data', function (packet) {
    t.equal(client1, packet.payload.toString())
  })
})

test('get message when client disconnects', function (t) {
  t.plan(2)
  var client1 = 'gav'
  var client2 = 'friend'
  var broker = aedes()

  broker.on('client', function (client) {
    if (client.id === client1) {
      client.subscribe({
        subscriptions: [{
          topic: '$SYS/+/disconnect/clients',
          qos: 0
        }]
      }, function (err) {
        t.error(err, 'no error')
      })
    } else {
      client.close()
    }
  })

  var s1 = connect(setup(broker), { clientId: client1 })
  connect(setup(broker), { clientId: client2 })

  s1.outStream.on('data', function (packet) {
    t.equal(client2, packet.payload.toString())
  })
})

test('get number of clients when a client dis/connects ', function (t) {
  t.plan(2)
  var client1 = 'Debjeet'
  var client2 = 'Bantu'
  var broker = aedes()

  broker.on('client', function (client) {
    if(client.id === client1){
      client.subscribe({
        subscriptions: [{
          topic: '$SYS/+/clients/total',
          qos: 0
        }]
      }, function (err) {
        t.error(err, 'no error')
      })
    }else{
      client.close()
    }
  })

  var s1 = connect(setup(broker), { clientId: client1 })

  s1.outStream.on('data', function (packet) {
    t.equal("1", packet.payload.toString())
  })
})
