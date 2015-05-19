var concat = require('concat-stream')
var Packet = require('../lib/packet')

function abstractPersistence (opts) {
  var test = opts.test
  var persistence = opts.persistence

  function storeRetained (instance, opts, cb) {
    opts = opts || {}

    var packet = {
      cmd: 'publish',
      id: 'broker-42',
      topic: opts.topic || 'hello/world',
      payload: opts.payload || new Buffer('muahah'),
      qos: 0,
      retain: true
    }

    instance.storeRetained(packet, function (err) {
      cb(err, packet)
    })
  }

  function matchRetainedWithPattern (t, pattern, opts) {
    var instance = persistence()

    storeRetained(instance, opts, function (err, packet) {
      t.notOk(err, 'no error')
      var stream = instance.createRetainedStream(pattern)

      stream.pipe(concat(function (list) {
        t.deepEqual(list, [packet], 'must return the packet')
        instance.destroy(t.end.bind(t))
      }))
    })
  }

  test('store and look up retained messages', function (t) {
    matchRetainedWithPattern(t, 'hello/world')
  })

  test('look up retained messages with a # pattern', function (t) {
    matchRetainedWithPattern(t, '#')
  })

  test('look up retained messages with a + pattern', function (t) {
    matchRetainedWithPattern(t, 'hello/+')
  })

  test('remove retained message', function (t) {
    var instance = persistence()
    storeRetained(instance, {}, function (err, packet) {
      t.notOk(err, 'no error')
      storeRetained(instance, {
        payload: new Buffer(0)
      }, function (err) {
        t.notOk(err, 'no error')

        var stream = instance.createRetainedStream('#')

        stream.pipe(concat(function (list) {
          t.deepEqual(list, [], 'must return an empty list')
          instance.destroy(t.end.bind(t))
        }))
      })
    })
  })

  test('storing twice a retained message should keep only the last', function (t) {
    var instance = persistence()
    storeRetained(instance, {}, function (err, packet) {
      t.notOk(err, 'no error')
      storeRetained(instance, {
        payload: new Buffer('ahah')
      }, function (err, packet) {
        t.notOk(err, 'no error')

        var stream = instance.createRetainedStream('#')

        stream.pipe(concat(function (list) {
          t.deepEqual(list, [packet], 'must return the last packet')
          instance.destroy(t.end.bind(t))
        }))
      })
    })
  })

  test('store and look up subscriptions by client', function (t) {
    var instance = persistence()
    var client = { id: 'abcde' }
    var subs = [{
      topic: 'hello',
      qos: 1
    }, {
      topic: 'matteo',
      qos: 1
    }, {
      topic: 'noqos',
      qos: 0
    }]

    instance.addSubscriptions(client, subs, function (err, reClient) {
      t.equal(reClient, client, 'client must be the same')
      t.notOk(err, 'no error')
      instance.subscriptionsByClient(client, function (err, resubs, reReClient) {
        t.equal(reReClient, client, 'client must be the same')
        t.notOk(err, 'no error')
        t.deepEqual(resubs, [{
          topic: 'hello',
          qos: 1
        }, {
          topic: 'matteo',
          qos: 1
        }])
        instance.destroy(t.end.bind(t))
      })
    })
  })

  test('remove subscriptions by client', function (t) {
    var instance = persistence()
    var client = { id: 'abcde' }
    var subs = [{
      topic: 'hello',
      qos: 1
    }, {
      topic: 'matteo',
      qos: 1
    }]

    instance.addSubscriptions(client, subs, function (err, reClient) {
      t.notOk(err, 'no error')
      instance.removeSubscriptions(client, ['hello'], function (err, reClient) {
        t.notOk(err, 'no error')
        t.equal(reClient, client, 'client must be the same')
        instance.subscriptionsByClient(client, function (err, resubs, reClient) {
          t.equal(reClient, client, 'client must be the same')
          t.notOk(err, 'no error')
          t.deepEqual(resubs, [{
            topic: 'matteo',
            qos: 1
          }])
          instance.destroy(t.end.bind(t))
        })
      })
    })
  })

  test('store and look up subscriptions by topic', function (t) {
    var instance = persistence()
    var client = { id: 'abcde' }
    var subs = [{
      topic: 'hello',
      qos: 1
    }, {
      topic: 'hello/#',
      qos: 1
    }, {
      topic: 'matteo',
      qos: 1
    }]

    instance.addSubscriptions(client, subs, function (err) {
      t.notOk(err, 'no error')
      instance.subscriptionsByTopic('hello', function (err, resubs) {
        t.notOk(err, 'no error')
        t.deepEqual(resubs, [{
          clientId: client.id,
          topic: 'hello/#',
          qos: 1
        }, {
          clientId: client.id,
          topic: 'hello',
          qos: 1
        }])
        instance.destroy(t.end.bind(t))
      })
    })
  })

  test('clean subscriptions', function (t) {
    var instance = persistence()
    var client = { id: 'abcde' }
    var subs = [{
      topic: 'hello',
      qos: 1
    }, {
      topic: 'matteo',
      qos: 1
    }]

    instance.addSubscriptions(client, subs, function (err) {
      t.notOk(err, 'no error')
      instance.cleanSubscriptions(client, function (err) {
        t.notOk(err, 'no error')
        instance.subscriptionsByTopic('hello', function (err, resubs) {
          t.notOk(err, 'no error')
          t.deepEqual(resubs, [], 'no subscriptions')

          instance.subscriptionsByClient(client, function (err, resubs) {
            t.error(err)
            t.deepEqual(resubs, null, 'no subscriptions')
            instance.destroy(t.end.bind(t))
          })
        })
      })
    })
  })

  test('add outgoing packet and stream it', function (t) {
    var instance = persistence()
    var sub = {
      clientId: 'abcde',
      topic: 'hello',
      qos: 1
    }
    var client = {
      id: sub.clientId
    }
    var packet = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1,
      dup: false,
      length: 14,
      retain: false,
      brokerId: 'mybroker',
      brokerCounter: 42
    }
    var expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1,
      retain: false,
      brokerId: 'mybroker',
      brokerCounter: 42,
      messageId: 0
    }

    instance.outgoingEnqueue(sub, packet, function (err) {
      t.error(err)
      var stream = instance.outgoingStream(client)

      stream.pipe(concat(function (list) {
        t.deepEqual(list, [expected], 'must return the packet')
        instance.destroy(t.end.bind(t))
      }))
    })
  })

  test('add outgoing packet and stream it twice', function (t) {
    var instance = persistence()
    var sub = {
      clientId: 'abcde',
      topic: 'hello',
      qos: 1
    }
    var client = {
      id: sub.clientId
    }
    var packet = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1,
      dup: false,
      length: 14,
      retain: false,
      brokerId: 'mybroker',
      brokerCounter: 42,
      messageId: 4242
    }
    var expected = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1,
      retain: false,
      brokerId: 'mybroker',
      brokerCounter: 42,
      messageId: 0
    }

    instance.outgoingEnqueue(sub, packet, function (err) {
      t.error(err)
      var stream = instance.outgoingStream(client)

      stream.pipe(concat(function (list) {
        t.deepEqual(list, [expected], 'must return the packet')

        var stream = instance.outgoingStream(client)

        stream.pipe(concat(function (list) {
          t.deepEqual(list, [expected], 'must return the packet')
          t.notEqual(list[0], expected, 'packet must be a different object')
          instance.destroy(t.end.bind(t))
        }))
      }))
    })
  })

  test('add outgoing packet and update messageId', function (t) {
    var instance = persistence()
    var sub = {
      clientId: 'abcde', topic: 'hello', qos: 1
    }
    var client = {
      id: sub.clientId
    }
    var packet = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 1,
      dup: false,
      length: 14,
      retain: false,
      brokerId: 'mybroker',
      brokerCounter: 42
    }

    instance.outgoingEnqueue(sub, packet, function (err) {
      t.error(err)
      var updated = new Packet(packet)
      updated.messageId = 42

      instance.outgoingUpdateMessageId(client, updated, function (err, reclient, repacket) {
        t.error(err)
        t.equal(reclient, client, 'client matches')
        t.equal(repacket, repacket, 'packet matches')

        var stream = instance.outgoingStream(client)

        stream.pipe(concat(function (list) {
          t.deepEqual(list, [updated], 'must return the packet')
          instance.destroy(t.end.bind(t))
        }))
      })
    })
  })

  test('add incoming packet, get it, and clear with messageId', function (t) {
    var instance = persistence()
    var client = {
      id: 'abcde'
    }
    var packet = {
      cmd: 'publish',
      topic: 'hello',
      payload: new Buffer('world'),
      qos: 2,
      dup: false,
      length: 14,
      retain: false,
      messageId: 42
    }

    instance.incomingStorePacket(client, packet, function (err) {
      t.error(err)

      instance.incomingGetPacket(client, {
        messageId: packet.messageId
      }, function (err, retrieved) {
        t.error(err)

        // adjusting the objects so they match
        delete retrieved.brokerCounter
        delete retrieved.brokerId
        delete packet.dup
        delete packet.length

        t.deepEqual(retrieved, packet, 'retrieved packet must be deeply equal')
        t.notEqual(retrieved, packet, 'retrieved packet must not be the same objet')

        instance.incomingDelPacket(client, retrieved, function (err) {
          t.error(err)

          instance.incomingGetPacket(client, {
            messageId: packet.messageId
          }, function (err, retrieved) {
            t.ok(err, 'must error')
            instance.destroy(t.end.bind(t))
          })
        })
      })
    })
  })
}

module.exports = abstractPersistence
