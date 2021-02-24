/* eslint no-unused-vars: 0 */
/* eslint no-undef: 0 */

import { expectType } from 'tsd'
import type {
  Aedes,
  Brokers,
  Client,
  Connection,
  ConnackPacket,
  AuthenticateError,
  AedesPublishPacket,
  PublishPacket,
  Subscription,
  SubscribePacket,
  UnsubscribePacket
} from '../../aedes'
import { Server } from '../../aedes'
import type { Packet } from 'mqtt-packet'
import { Socket } from 'net'

// Aedes server
const broker = Server({
  concurrency: 100,
  heartbeatInterval: 60000,
  connectTimeout: 30000,
  id: 'aedes',
  preConnect: (client: Client, packet: Packet, callback) => {
    if (client.req) {
      callback(new Error('not websocket stream'), false)
    }
    if (client.conn instanceof Socket && client.conn.remoteAddress === '::1') {
      callback(null, true)
    } else {
      callback(new Error('connection error'), false)
    }
  },
  authenticate: (client: Client, username: string, password: Buffer, callback) => {
    if (username === 'test' && password === Buffer.from('test') && client.version === 4) {
      callback(null, true)
    } else {
      const error = new Error() as AuthenticateError
      error.returnCode = 1

      callback(error, false)
    }
  },
  authorizePublish: (client: Client, packet: PublishPacket, callback) => {
    if (packet.topic === 'aaaa') {
      return callback(new Error('wrong topic'))
    }

    if (packet.topic === 'bbb') {
      packet.payload = Buffer.from('overwrite packet payload')
    }

    callback(null)
  },
  authorizeSubscribe: (client: Client, sub: Subscription, callback) => {
    if (sub.topic === 'aaaa') {
      return callback(new Error('wrong topic'))
    }

    if (sub.topic === 'bbb') {
      // overwrites subscription
      sub.qos = 2
    }

    callback(null, sub)
  },
  authorizeForward: (client: Client, packet: AedesPublishPacket) => {
    if (packet.topic === 'aaaa' && client.id === 'I should not see this') {
      return null
      // also works with return undefined
    } else if (packet.topic === 'aaaa' && client.id === 'I should not see this either') {
      return
    }

    if (packet.topic === 'bbb') {
      packet.payload = Buffer.from('overwrite packet payload')
    }

    return packet
  }
})

expectType<Aedes>(broker)

expectType<Brokers>(broker.brokers)

expectType<Aedes>(broker.on('closed', () => {}))
expectType<Aedes>(broker.on('client', (client: Client) => {}))
expectType<Aedes>(broker.on('clientError', (client: Client, error: Error) => {}))
expectType<Aedes>(broker.on('connackSent', (packet: ConnackPacket, client: Client) => {}))

expectType<void>(broker.publish(
  {} as PublishPacket,
  (error?: Error) => {
    if (error) {
      console.error(error)
    }
  }
))

expectType<void>(broker.subscribe(
  'topic',
  (packet: AedesPublishPacket, callback: () => void) => {},
  () => {}
))

expectType<void>(broker.unsubscribe(
  'topic',
  (packet: AedesPublishPacket, callback: () => void) => {},
  () => {}
))

expectType<void>(broker.close())
expectType<void>(broker.close(() => {}))

// Aedes client
const client = broker.handle({} as Connection)

expectType<Client>(client)

expectType<Connection>(client.conn)

expectType<Client>(client.on('connected', () => {}))
expectType<Client>(client.on('error', (error: Error) => {
  if (error) {
    console.error(error)
  }
}))

expectType<void>(client.publish({} as PublishPacket, (error?: Error) => {
  if (error) {
    console.error(error)
  }
}))
expectType<void>(client.publish({} as PublishPacket))

expectType<void>(client.subscribe({} as Subscription, (error?: Error) => {
  if (error) {
    console.error(error)
  }
}))
expectType<void>(client.subscribe({} as Subscription))
expectType<void>(client.subscribe([] as Subscription[]))
expectType<void>(client.subscribe({} as SubscribePacket))

expectType<void>(client.unsubscribe({} as Subscription, (error?: Error) => {
  if (error) {
    console.error(error)
  }
}))
expectType<void>(client.unsubscribe({} as Subscription))
expectType<void>(client.unsubscribe([] as Subscription[]))
expectType<void>(client.unsubscribe({} as UnsubscribePacket))

expectType<void>(client.emptyOutgoingQueue())
expectType<void>(client.emptyOutgoingQueue(() => {}))

expectType<void>(client.close())
expectType<void>(client.close(() => {}))
