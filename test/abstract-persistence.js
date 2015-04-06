
var concat = require('concat-stream')

function abstractPersistence(opts) {
  var test        = opts.test
    , persistence = opts.persistence

  test('store and look up retained messages', function(t) {
    var instance = persistence()
      , packet   = {
            cmd: 'publish'
          , id: 'broker-42'
          , topic: 'hello/world'
          , payload: new Buffer('muahah')
          , qos: 0
          , retain: true
        }

    instance.store(packet, function(err) {
      t.notOk(err, 'no error')
      var stream = instance.createRetainedStream('hello/world')

      stream.pipe(concat(function(list) {
        t.deepEqual(list, [packet], 'must return the packet')
        instance.destroy(t.end.bind(t))
      }))
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
