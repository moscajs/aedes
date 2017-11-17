var config = require('./redis_mqemitter-redis_config')
var qos2 = require('../../qos2')
qos2.aedesConfig = {persistence: config.aedesPersistenceRedis, mq: config.mqRedis}
var test = require('tape').test
test('completed qos2 test with aedes-persistence-redis and mq-redis', function (t) {
  t.end()
})
test.onFinish(function () {
  process.exit()
})
