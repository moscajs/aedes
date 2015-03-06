
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
}

module.exports = abstractPersistence
