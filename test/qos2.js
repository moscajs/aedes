
var test      = require('tape').test
  , helper    = require('./helper')
  , aedes     = require('../')
  , setup     = helper.setup
  , connect   = helper.connect
  , noError   = helper.noError

test.skip('publish QoS 2', function(t) {
  var s         = connect(setup())

  s.inStream.write({
      cmd: 'publish'
    , topic: 'hello'
    , payload: 'world'
    , qos: 2
    , messageId: 42
  })

  s.outStream.once('data', function(packet) {
    t.deepEqual(packet, {
        cmd: 'pubrec'
      , messageId: 42
    }, 'pubrec must match')

    s.inStream.write({
        cmd: 'pubrel'
      , messageId: 42
    })

    s.outStream.once('data', function(packet) {
      t.deepEqual(packet, {
          cmd: 'pubcomp'
        , messageId: 42
      }, 'pubcomp must match')

      t.end()
    })
  })
})
