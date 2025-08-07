import { test } from 'node:test'
import { once } from 'node:events'
import {
  connect,
  createAndConnect,
  nextPacket,
  nextPacketWithTimeOut,
  setup,
  subscribe,
} from './helper.js'

test('publish direct to a single client QoS 0', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('publish direct to a single client throws error', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, { connect: { clean: false } })

  s.broker.persistence.outgoingEnqueue = async () => {
    throw new Error('Throws error')
  }

  await new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1,
      retain: false
    }, (err) => {
      t.assert.equal('Throws error', err.message, 'throws error')
      resolve()
    })
  })
})

test('publish direct to a single client throws error 2', async (t) => {
  t.plan(1)

  const s = await createAndConnect(t, { connect: { clean: false } })

  s.broker.persistence.outgoingUpdate = async () => {
    throw new Error('Throws error')
  }

  s.client.publish({
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    retain: false
  }, () => { })

  const [err] = await once(s.client, 'error')
  t.assert.equal('Throws error', err.message, 'throws error')
})

test('publish direct to a single client QoS 1', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const processPacket = async () => {
    const packet = await nextPacket(s)
    expected.messageId = packet.messageId
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  }

  // run parallel
  await Promise.all([
    publishPacket,
    processPacket()
  ])
})

test('publish QoS 2 throws error in pubrel', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const clientError = async () => {
    once(s.broker, 'clientError')
    t.assert.ok(true, 'throws error')
  }

  const processPacket = async () => {
    const packet = await nextPacket(s)
    t.assert.equal(packet.cmd, 'publish', 'publish packet')
    s.inStream.write({
      cmd: 'pubrec',
      messageId: packet.messageId
    })
    s.broker.persistence.outgoingUpdate = async () => {
      throw new Error('error')
    }
  }

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })
  // run parallel
  await Promise.all([
    clientError(),
    processPacket(),
    publishPacket,
  ])
})

test('publish direct to a single client QoS 2', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  let publishCount = 0
  let nonPublishCount = 0

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
    s.client.on('error', (err) => {
      t.assert.fail(err)
    })
  })

  const checkOnClose = async () => {
    await once(s.inStream, 'close')
    t.assert.equal(publishCount, 1)
    t.assert.equal(nonPublishCount, 1)
  }

  const processPacket = async () => {
    const packet1 = await nextPacket(s)
    t.assert.equal(packet1.cmd, 'publish', 'publish packet')
    publishCount++
    s.inStream.write({
      cmd: 'pubrec',
      messageId: packet1.messageId
    })
    const packet2 = await nextPacket(s)
    t.assert.equal(packet2.cmd, 'pubrel', 'pubrel packet')
    nonPublishCount++
    s.inStream.write({
      cmd: 'pubcomp',
      messageId: packet2.messageId
    })
    s.inStream.destroy()
  }
  // run parallel
  await Promise.all([
    checkOnClose(),
    processPacket(),
    publishPacket,
  ])
})

test('emit a `ack` event on PUBACK for QoS 1 [clean=false]', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t, { connect: { clean: false } })
  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    retain: false,
    dup: false
  }

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const brokerAck = async () => {
    const [packet] = await once(s.broker, 'ack')
    expected.brokerId = packet.brokerId
    expected.brokerCounter = packet.brokerCounter
    expected.messageId = packet.messageId
    t.assert.deepEqual(structuredClone(packet), expected, 'ack packet is original packet')
    t.assert.ok(true, 'got the ack event')
  }

  const processPacket = async () => {
    const packet = await nextPacket(s)
    t.assert.equal(packet.cmd, 'publish', 'publish packet')
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  }

  // run parallel
  await Promise.all([
    brokerAck(),
    processPacket(),
    publishPacket,
  ])
})

test('emit a `ack` event on PUBACK for QoS 1 [clean=true]', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t, { connect: { clean: true } })

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const brokerAck = async () => {
    const [packet] = await once(s.broker, 'ack')
    t.assert.equal(packet, undefined, 'ack packet is undefined')
    t.assert.ok(true, 'got the ack event')
  }

  const processPacket = async () => {
    const packet = await nextPacket(s)
    t.assert.equal(packet.cmd, 'publish', 'publish packet')
    s.inStream.write({
      cmd: 'puback',
      messageId: packet.messageId
    })
  }
  // run parallel
  await Promise.all([
    brokerAck(),
    processPacket(),
    publishPacket,
  ])
})

test('emit a `ack` event on PUBCOMP for QoS 2 [clean=false]', async (t) => {
  t.plan(7)

  const s = await createAndConnect(t, { connect: { clean: false } })

  let messageId
  let clientId

  const publishPacket = new Promise(resolve => {
    clientId = s.client.id
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const brokerAck = async () => {
    const [packet, client] = await once(s.broker, 'ack')
    t.assert.equal(client.id, clientId)
    t.assert.equal(packet.messageId, messageId)
    t.assert.equal(packet.cmd, 'pubrel', 'ack packet is pubrel')
    t.assert.ok(true, 'got the ack event')
  }

  const processPacket = async () => {
    const packet1 = await nextPacket(s)
    t.assert.equal(packet1.cmd, 'publish', 'publish packet')
    s.inStream.write({
      cmd: 'pubrec',
      messageId: packet1.messageId
    })
    const packet2 = await nextPacket(s)
    t.assert.equal(packet2.cmd, 'pubrel', 'pubrel packet')
    messageId = packet2.messageId
    s.inStream.write({
      cmd: 'pubcomp',
      messageId: packet2.messageId
    })
  }
  // run parallel
  await Promise.all([
    brokerAck(),
    processPacket(),
    publishPacket,
  ])
})

test('emit a `ack` event on PUBCOMP for QoS 2 [clean=true]', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t, { connect: { clean: true } })

  const publishPacket = new Promise(resolve => {
    s.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 2
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const brokerAck = async () => {
    const [packet, client] = await once(s.broker, 'ack')
    t.assert.ok(client, 'client is defined')
    t.assert.equal(packet, undefined, 'ack packet is undefined')
    t.assert.ok(true, 'got the ack event')
  }

  const processPacket = async () => {
    const packet1 = await nextPacket(s)
    t.assert.equal(packet1.cmd, 'publish', 'publish packet')
    s.inStream.write({
      cmd: 'pubrec',
      messageId: packet1.messageId
    })
    const packet2 = await nextPacket(s)
    t.assert.equal(packet2.cmd, 'pubrel', 'pubrel packet')
    s.inStream.write({
      cmd: 'pubcomp',
      messageId: packet2.messageId
    })
  }
  // run parallel
  await Promise.all([
    brokerAck(),
    processPacket(),
    publishPacket,
  ])
})

test('offline message support for direct publish', async (t) => {
  t.plan(2)

  const opts = {
    connect: {
      clean: false,
      clientId: 'abcde'
    }
  }
  const s1 = await createAndConnect(t, opts)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 14,
    qos: 1,
    retain: false
  }

  const publishPacket = new Promise(resolve => {
    s1.client.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const processPacket = async () => {
    const packet1 = await nextPacket(s1)
    // create a new subscriber, this will disconnect s1
    const s2 = setup(s1.broker)
    await connect(s2, opts)
    s2.inStream.write({
      cmd: 'puback',
      messageId: packet1.messageId
    })
    const packet2 = await nextPacket(s2)
    delete packet2.messageId
    t.assert.deepEqual(structuredClone(packet2), expected, 'packet must match')
  }
  // run parallel
  await Promise.all([
    processPacket(),
    publishPacket,
  ])
})

test('subscribe a client programmatically', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('subscribe a client programmatically clears retain', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')

      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0,
        retain: true
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  // two packets are streamed
  // - one with retain === true
  // - one with retain === false
  // the order varies depending on timing so we
  // need to be able to handle both scenarios

  for await (const packet of s.outStream) {
    if (packet.retain === false) {
      t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
      s.inStream.end({
        cmd: 'disconnect'
      })
      break
    }
  }
})

test('subscribe a bridge programmatically keeps retain', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: true
  }

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 0,
      rap: true
    }, (err) => {
      t.assert.ok(!err, 'no error')

      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0,
        retain: true
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  const packet = await nextPacket(s)
  if (packet.retain === true) {
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
  }
})

test('subscribe throws error when QoS > 0', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')

      // makes writeQos throw error
      s.client.connected = false
      s.client.connecting = false

      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 1
      }, (err) => {
        t.assert.ok(!err, 'no error')
      })
    })

    s.broker.on('clientError', (client, error) => {
      t.assert.equal(error.message, 'connection closed', 'should throw clientError')
      resolve()
    })
  })
})

test('subscribe a client programmatically - wildcard', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello/world/1',
    payload: Buffer.from('world'),
    dup: false,
    length: 20,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.subscribe({
      topic: '+/world/1',
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')

      s.broker.publish({
        topic: 'hello/world/1',
        payload: Buffer.from('world'),
        qos: 0
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('unsubscribe a client', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.client.unsubscribe([{
        topic: 'hello',
        qos: 0
      }], (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })
})

test('unsubscribe should not call removeSubscriptions when [clean=true]', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t, { connect: { clean: true } })

  s.broker.persistence.removeSubscriptions = async () => {
    throw new Error('remove subscription is called')
  }

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 1
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.client.unsubscribe({
        unsubscriptions: [{
          topic: 'hello',
          qos: 1
        }],
        messageId: 42
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })
})

test('unsubscribe throws error', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 0
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.broker.unsubscribe = (topic, func, done) => {
        done(new Error('error'))
      }
      s.client.unsubscribe({
        topic: 'hello',
        qos: 0
      }, () => {
        t.assert.ok(true, 'throws error')
        resolve()
      })
    })
  })
})

test('unsubscribe throws error 2', async (t) => {
  t.plan(2)

  const s = await createAndConnect(t)

  await new Promise(resolve => {
    s.client.subscribe({
      topic: 'hello',
      qos: 2
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.broker.persistence.removeSubscriptions = async () => {
        throw new Error('error')
      }
      s.client.unsubscribe({
        unsubscriptions: [{
          topic: 'hello',
          qos: 2
        }],
        messageId: 42
      }, () => {
        t.assert.ok(true, 'throws error')
        resolve()
      })
    })
  })
})

test('subscribe a client programmatically multiple topics', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.subscribe([{
      topic: 'hello',
      qos: 0
    }, {
      topic: 'aaa',
      qos: 0
    }], (err) => {
      t.assert.ok(!err, 'no error')
      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('subscribe a client programmatically with full packet', async (t) => {
  t.plan(3)

  const s = await createAndConnect(t)

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    dup: false,
    length: 12,
    qos: 0,
    retain: false
  }

  await new Promise(resolve => {
    s.client.subscribe({
      subscriptions: [{
        topic: 'hello',
        qos: 0
      }, {
        topic: 'aaa',
        qos: 0
      }]
    }, (err) => {
      t.assert.ok(!err, 'no error')

      s.broker.publish({
        topic: 'hello',
        payload: Buffer.from('world'),
        qos: 0
      }, (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('get message when client connects', async (t) => {
  t.plan(2)

  const client1 = 'gav'
  const client2 = 'friend'
  const s = await createAndConnect(t, { connect: { clientId: client1 } })

  await new Promise(resolve => {
    s.client.subscribe({
      subscriptions: [{
        topic: '$SYS/+/new/clients',
        qos: 0
      }]
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const s2 = setup(s.broker)
  await connect(s2, { connect: { clientId: client2 } })

  const packet = await nextPacket(s)
  t.assert.equal(client2, packet.payload.toString())
})

test('get message when client disconnects', async (t) => {
  t.plan(2)

  const client1 = 'gav'
  const client2 = 'friend'
  const s = await createAndConnect(t, { connect: { clientId: client1 } })

  await new Promise(resolve => {
    s.client.subscribe({
      subscriptions: [{
        topic: '$SYS/+/disconnect/clients',
        qos: 0
      }]
    }, (err) => {
      t.assert.ok(!err, 'no error')
      resolve()
    })
  })

  const s2 = setup(s.broker)
  await connect(s2, { connect: { clientId: client2 } })
  s2.client.close()

  const packet = await nextPacket(s)
  t.assert.equal(client2, packet.payload.toString())
})

test('should not receive a message on negated subscription', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t)

  s.broker.authorizeSubscribe = (client, sub, callback) => {
    callback(null, null)
  }

  await new Promise(resolve => {
    s.broker.publish({
      topic: 'hello',
      payload: Buffer.from('world'),
      qos: 0,
      retain: true
    }, (err) => {
      t.assert.ok(!err, 'no error')
      s.client.subscribe([{
        topic: 'hello',
        qos: 0
      },
      {
        topic: 'hello',
        qos: 0
      }], (err) => {
        t.assert.ok(!err, 'no error')
        resolve()
      })
    })

    s.broker.on('subscribe', subs => {
      t.assert.equal(subs.length, 1, 'Should dedupe subs')
      t.assert.equal(subs[0].qos, 128, 'Qos should be 128 (Fail)')
    })
  })

  const packet = await nextPacketWithTimeOut(s, 10)
  t.assert.equal(packet, null, 'Packet should not be received')
})

test('programmatically add custom subscribe', async (t) => {
  t.plan(6)

  const s = await createAndConnect(t, { connect: { clientId: 'my-client-xyz-7' } })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    length: 12,
    dup: false
  }
  const deliverP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false,
    dup: false,
    clientId: 'my-client-xyz-7'
  }

  function deliver (packet, cb) {
    deliverP.brokerId = s.broker.id
    deliverP.brokerCounter = s.broker.counter
    t.assert.deepEqual(structuredClone(packet), deliverP, 'packet matches')
    cb()
  }

  await subscribe(t, s, 'hello', 0)
  await new Promise(resolve => {
    s.broker.subscribe('hello', deliver, () => {
      t.assert.ok(true, 'subscribed')
      resolve()
    })
  })

  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 0,
    messageId: 42
  })

  const packet = await nextPacket(s)
  t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
})

test('custom function in broker.subscribe', async (t) => {
  t.plan(5)

  const s = await createAndConnect(t, { connect: { clientId: 'my-client-xyz-6' } })

  const expected = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    retain: false,
    dup: false,
    messageId: undefined,
    clientId: 'my-client-xyz-6'
  }

  function deliver (packet, cb) {
    expected.brokerId = s.broker.id
    expected.brokerCounter = s.broker.counter
    t.assert.deepEqual(structuredClone(packet), expected, 'packet matches')
    cb()
  }

  await new Promise(resolve => {
    s.broker.subscribe('hello', deliver, () => {
      t.assert.ok(true, 'subscribed')
      resolve()
    })
  })
  s.inStream.write({
    cmd: 'publish',
    topic: 'hello',
    payload: 'world',
    qos: 1,
    messageId: 42
  })

  const [packet, client] = await once(s.broker, 'publish')
  t.assert.ok(client, 'client exists')
  t.assert.equal(packet.topic, 'hello')
  t.assert.equal(packet.messageId, 42)
})

test('custom function in broker.unsubscribe', async (t) => {
  t.plan(4)

  const s = await createAndConnect(t)

  function deliver (packet, cb) {
    t.assert.fail('should not be called')
    cb()
  }

  await new Promise(resolve => {
    s.broker.subscribe('hello', deliver, () => {
      t.assert.ok(true, 'subscribed')
      s.broker.unsubscribe('hello', deliver, () => {
        t.assert.ok(true, 'unsubscribe')
        s.inStream.write({
          cmd: 'publish',
          topic: 'hello',
          payload: 'word',
          qos: 1,
          messageId: 42
        })
        resolve()
      })
    })
  })
  const [packet, client] = await once(s.broker, 'publish')
  t.assert.ok(client, 'client exists')
  t.assert.equal(packet.messageId, 42)
})
