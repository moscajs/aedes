
var test = require('tape').test
var memory = require('../lib/persistence')
var abs = require('./abstract-persistence')

abs({
  test: test,
  persistence: memory
})
