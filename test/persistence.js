
var test   = require('tape').test
  , memory = require('../lib/persistence')
  , abs    = require('./abstract-persistence')

abs({
  test: test,
  persistence: memory
})
