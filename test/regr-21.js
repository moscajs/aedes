import { test } from 'tap'
import { setup, connect } from './helper.js'
import { Aedes } from '../aedes.js'

test('after an error, outstanding packets are discarded', function (t) {
  t.plan(1)
  Aedes.createBroker().then((broker) => {
    const s = connect(setup(broker), {
      keepalive: 1000
    })
    t.teardown(s.broker.close.bind(s.broker))

    const packet = {
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    }

    s.broker.mq.on('hello', function (msg, cb) {
      t.pass('first msg received')
      s.inStream.destroy(new Error('something went wrong'))
      cb()
      setImmediate(() => {
        packet.topic = 'foo'
        s.inStream.write(packet)
        s.inStream.write(packet)
      })
    })
    s.broker.mq.on('foo', function (msg, cb) {
      t.fail('msg received')
    })
    s.inStream.write(packet)
  })
})
