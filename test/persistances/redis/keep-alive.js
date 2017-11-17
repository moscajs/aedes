var config = require('./redis_mqemitter-redis_config')
var keepAlive = require('../../keep-alive')
keepAlive.aedesConfig = {persistence: config.aedesPersistenceRedis, mq: config.mqRedis}
var test = require('tape').test
test('completed keep-alive test with aedes-persistence-redis and mq-redis', function (t) {
  t.end()
})
test.onFinish(function () {
  process.exit()
})
