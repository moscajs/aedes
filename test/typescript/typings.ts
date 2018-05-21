// relative path uses package.json {"types":"types/index.d.ts", ...}

import Aedes = require ('../..')
import { IPublishPacket, ISubscribePacket, ISubscription, IUnsubscribePacket } from 'mqtt-packet'
import { createServer } from 'net'

const aedes = Aedes({
  concurrency: 100,
  heartbeatInterval: 60000,
  connectTimeout: 30000,
  authenticate: (client, username: string, password: string, callback) => {
    if (username === 'test' && password === 'test') {
      callback(null, true)
    } else {
      const error = new Error() as Error & { returnCode: number }
      error.returnCode = 1

      callback(error, false)
    }
  },
  authorizePublish: (client, packet: IPublishPacket, callback) => {
    if (packet.topic === 'aaaa') {
      return callback(new Error('wrong topic'))
    }

    if (packet.topic === 'bbb') {
      packet.payload = new Buffer('overwrite packet payload')
    }

    callback(null)
  },
  authorizeSubscribe: (client, sub: ISubscription, callback) => {
    if (sub.topic === 'aaaa') {
      return callback(new Error('wrong topic'))
    }

    if (sub.topic === 'bbb') {
      // overwrites subscription
      sub.qos = 2
    }

    callback(null, sub)
  },
  authorizeForward: (client, packet: IPublishPacket) => {
    if (packet.topic === 'aaaa' && client.id === 'I should not see this') {
      return null
      // also works with return undefined
    } else if (packet.topic === 'aaaa' && client.id === 'I should not see this either') {
      return
    }

    if (packet.topic === 'bbb') {
      packet.payload = new Buffer('overwrite packet payload')
    }

    return packet
  }
})

const server = createServer(aedes.handle)

aedes.on('closed', () => {
  console.log(`closed`)
})

aedes.on('client', client => {
  console.log(`client: ${client.id} connected`)
})

aedes.on('clientDisconnect', client => {
  console.log(`client: ${client.id} disconnected`)
})

aedes.on('keepaliveTimeout', client => {
  console.log(`client: ${client.id} timed out`)
})

aedes.on('connackSent', client => {
  console.log(`client: ${client.id} connack sent`)
})

aedes.on('clientError', client => {
  console.log(`client: ${client.id} error`)
})

aedes.on('connectionError', client => {
  console.log('connectionError')
})

aedes.on('ping', (packet, client) => {
  console.log(`client: ${client.id} ping with packet ${packet.id}`)
})

aedes.on('publish', (packet, client) => {
  console.log(`client: ${client.id} published packet ${packet.id}`)
})

aedes.on('ack', (packet, client) => {
  console.log(`client: ${client.id} ack with packet ${packet.id}`)
})

aedes.on('subscribe', (subscriptions, client) => {
  console.log(`client: ${client.id} subsribe`)
})

aedes.on('unsubscribe', (subscriptions, client) => {
  console.log(`client: ${client.id} subsribe`)
})

aedes.subscribe('aaaa', (packet: ISubscribePacket, cb) => {
  console.log('cmd')
  console.log(packet.subscriptions)
  cb()
}, () => {
  console.log('done subscribing')
})

aedes.unsubscribe('aaaa', (packet: IUnsubscribePacket, cb) => {
  console.log('cmd')
  console.log(packet.unsubscriptions)
  cb()
}, () => {
  console.log('done unsubscribing')
})

aedes.close()
