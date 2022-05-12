'use strict'

const { test } = require('tap')
const { setup, connect, subscribe } = require('./helper')

test('normal client sends a publish message and shall receive it back', function (t) {
  const s = connect(setup())
  t.teardown(s.broker.close.bind(s.broker))

  const handle = setTimeout(() => {
    t.fail('did not receive packet back')
    t.end()
  }, 1000)

  subscribe(t, s, 'hello', 0, function () {
    s.outStream.on('data', () => {
      clearTimeout(handle)
      t.end()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
})

test('bridge client sends a publish message but shall not receive it back', function (t) {
  const s = connect(setup(), { clientId: 'my-client-bridge-1', protocolVersion: 128 + 4 })
  t.teardown(s.broker.close.bind(s.broker))

  const handle = setTimeout(() => t.end(), 1000)

  subscribe(t, s, 'hello', 0, function () {
    s.outStream.on('data', function () {
      clearTimeout(handle)
      t.fail('should not receive packet back')
      t.end()
    })

    s.inStream.write({
      cmd: 'publish',
      topic: 'hello',
      payload: 'world'
    })
  })
})
