'use strict'

const { test } = require('tap')
const { setup, connect, subscribe } = require('./helper')

for (const qos of [0, 1]) {
  const packet = {
    qos,
    cmd: 'publish',
    topic: 'hello',
    payload: 'world'
  }

  if (qos > 0) packet.messageId = 42
  
  test('normal client sends a publish message and shall receive it back, qos = ' + qos, function (t) {
    const s = connect(setup())
    t.teardown(s.broker.close.bind(s.broker))
  
    const handle = setTimeout(() => {
      t.fail('did not receive packet back')
      t.end()
    }, 1000)
  
    subscribe(t, s, 'hello', qos, function () {
      s.outStream.on('data', (packet) => {
        if (packet.cmd == 'publish') {
          clearTimeout(handle)
          t.end()
        }
      })
  
      s.inStream.write(packet)
    })
  })

  test('bridge client sends a publish message but shall not receive it back, qos = ' + qos, function (t) {
    const s = connect(setup(), { clientId: 'my-client-bridge-1', protocolVersion: 128 + 4 })
    t.teardown(s.broker.close.bind(s.broker))

    const handle = setTimeout(() => t.end(), 1000)

    subscribe(t, s, 'hello', qos, function () {
      s.outStream.on('data', function () {
        clearTimeout(handle)
        t.fail('should not receive packet back')
        t.end()
      })

      s.inStream.write(packet)
    })
  })
}

