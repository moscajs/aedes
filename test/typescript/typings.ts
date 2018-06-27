// relative path uses package.json {"types":"types/index.d.ts", ...}

import { Server, Client, AuthenticateError } from '../..'
import { IPublishPacket, ISubscribePacket, ISubscription, IUnsubscribePacket } from 'mqtt-packet'
import { createServer } from 'net'

const broker = Server({
  concurrency: 100,
  heartbeatInterval: 60000,
  connectTimeout: 30000,
  authenticate: (client: Client, username: string, password: string, callback) => {
    if (username === 'test' && password === 'test') {
      callback(null, true)
    } else {
      const error = new Error() as AuthenticateError
      error.returnCode = 1

      callback(error, false)
    }
  },
  authorizePublish: (client: Client, packet: IPublishPacket, callback) => {
    if (packet.topic === 'aaaa') {
      return callback(new Error('wrong topic'))
    }

    if (packet.topic === 'bbb') {
      packet.payload = new Buffer('overwrite packet payload')
    }

    callback(null)
  },
  authorizeSubscribe: (client: Client, sub: ISubscription, callback) => {
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

const server = createServer(broker.handle)

broker.on('closed', () => {
  console.log(`closed`)
})

broker.on('client', client => {
  console.log(`client: ${client.id} connected`)
})

broker.on('clientDisconnect', client => {
  console.log(`client: ${client.id} disconnected`)
})

broker.on('keepaliveTimeout', client => {
  console.log(`client: ${client.id} timed out`)
})

broker.on('connackSent', client => {
  console.log(`client: ${client.id} connack sent`)
})

broker.on('clientError', client => {
  console.log(`client: ${client.id} error`)
})

broker.on('connectionError', client => {
  console.log('connectionError')
})

broker.on('ping', (packet, client) => {
  console.log(`client: ${client.id} ping with packet ${packet.id}`)
})

broker.on('publish', (packet, client) => {
  console.log(`client: ${client.id} published packet ${packet.id}`)
})

broker.on('ack', (packet, client) => {
  console.log(`client: ${client.id} ack with packet ${packet.id}`)
})

broker.on('subscribe', (subscriptions, client) => {
  console.log(`client: ${client.id} subsribe`)
})

broker.on('unsubscribe', (subscriptions, client) => {
  console.log(`client: ${client.id} subsribe`)
})

broker.subscribe('aaaa', (packet: ISubscribePacket, cb) => {
  console.log('cmd')
  console.log(packet.subscriptions)
  cb()
}, () => {
  console.log('done subscribing')
})

broker.unsubscribe('aaaa', (packet: IUnsubscribePacket, cb) => {
  console.log('cmd')
  console.log(packet.unsubscriptions)
  cb()
}, () => {
  console.log('done unsubscribing')
})

broker.close()
