
var concat = require('concat-stream')

function abstractPersistence(opts) {
  var test        = opts.test
    , persistence = opts.persistence

  function storeRetained(instance, opts, cb) {
    opts = opts || {}

    var packet   = {
            cmd: 'publish'
          , id: 'broker-42'
          , topic: opts.topic || 'hello/world'
          , payload: opts.payload || new Buffer('muahah')
          , qos: 0
          , retain: true
        }

    instance.storeRetained(packet, function(err) {
      cb(err, packet)
    })
  }

  function matchRetainedWithPattern(t, pattern, opts) {
    var instance = persistence()

    storeRetained(instance, opts, function(err, packet) {
      t.notOk(err, 'no error')
      var stream = instance.createRetainedStream(pattern)

      stream.pipe(concat(function(list) {
        t.deepEqual(list, [packet], 'must return the packet')
        instance.destroy(t.end.bind(t))
      }))
    })
  }

  test('store and look up retained messages', function(t) {
    matchRetainedWithPattern(t, 'hello/world')
  })

  test('look up retained messages with a # pattern', function(t) {
    matchRetainedWithPattern(t, '#')
  })

  test('look up retained messages with a + pattern', function(t) {
    matchRetainedWithPattern(t, 'hello/+')
  })

  test('remove retained message', function(t) {
    var instance = persistence()
    storeRetained(instance, {}, function(err, packet) {
      t.notOk(err, 'no error')
      storeRetained(instance, {
          payload: new Buffer(0)
      }, function(err) {
        t.notOk(err, 'no error')

        var stream = instance.createRetainedStream('#')

        stream.pipe(concat(function(list) {
          t.deepEqual(list, [], 'must return an empty list')
          instance.destroy(t.end.bind(t))
        }))
      })
    })
  })

  test('storing twice a retained message should keep only the last', function(t) {
    var instance = persistence()
    storeRetained(instance, {}, function(err, packet) {
      t.notOk(err, 'no error')
      storeRetained(instance, {
          payload: new Buffer('ahah')
      }, function(err, packet) {
        t.notOk(err, 'no error')

        var stream = instance.createRetainedStream('#')

        stream.pipe(concat(function(list) {
          t.deepEqual(list, [packet], 'must return the last packet')
          instance.destroy(t.end.bind(t))
        }))
      })
    })
  })

  test('store and look up subscriptions by client', function(t) {
    var instance  = persistence()
      , clientId  = 'abcde'
      , subs      = [{
            topic: 'hello'
          , qos: 1
        },  {
            topic: 'matteo'
          , qos: 1
        }]

    instance.persistSubscriptions(clientId, subs, function(err) {
      t.notOk(err, 'no error')
      instance.subscriptionsByClient(clientId, function(err, resubs) {
        t.notOk(err, 'no error')
        t.deepEqual(resubs, subs)
        instance.destroy(t.end.bind(t))
      })
    })
  })

  test('store and look up subscriptions by pattern', function(t) {
    var instance  = persistence()
      , clientId  = 'abcde'
      , subs      = [{
            topic: 'hello'
          , qos: 1
        },  {
            topic: 'matteo'
          , qos: 1
        }]

    instance.persistSubscriptions(clientId, subs, function(err) {
      t.notOk(err, 'no error')
      var stream = instance.subscriptionsByPattern('hello')

      stream.pipe(concat(function(resubs) {
        t.notOk(err, 'no error')
        t.deepEqual(resubs, [{
            clientId: clientId
          , topic: 'hello'
          , qos: 1
        }])
        instance.destroy(t.end.bind(t))
      }))
    })
  })

  test('clean subscriptions', function(t) {
    var instance  = persistence()
      , clientId  = 'abcde'
      , subs      = [{
            topic: 'hello'
          , qos: 1
        },  {
            topic: 'matteo'
          , qos: 1
        }]

    instance.persistSubscriptions(clientId, subs, function(err) {
      t.notOk(err, 'no error')
      instance.cleanSubscriptions(clientId, function(err) {
        t.notOk(err, 'no error')
        var stream = instance.subscriptionsByPattern('hello')

        stream.pipe(concat(function(resubs) {
          t.deepEqual(resubs, [], 'no subscriptions')

          instance.subscriptionsByClient(clientId, function(err, resubs) {
            t.deepEqual(resubs, [], 'no subscriptions')
            instance.destroy(t.end.bind(t))
          })
        }))
      })
    })
  })
}

module.exports = abstractPersistence
