var config = require('./redis_mqemitter-redis_config')
var clientPubSub = require('../../client-pub-sub')
clientPubSub.aedesConfig = {persistence: config.aedesPersistenceRedis, mq: config.mqRedis}
var test = require('tape').test
test('completed client-pub-sub test with aedes-persistence-redis and mq-redis', function (t) {
  t.end()
})
test.onFinish(function () {
  process.exit()
})
