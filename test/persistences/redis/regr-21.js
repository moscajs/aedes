var config = require('./redis_mqemitter-redis_config')
var regr21 = require('../../regr-21')
regr21.aedesConfig = {persistence: config.aedesPersistenceRedis, mq: config.mqRedis}
var test = require('tape').test
test('completed regr-21 test with aedes-persistence-redis and mq-redis', function (t) {
  t.end()
})
test.onFinish(function () {
  process.exit()
})
