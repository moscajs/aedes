import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type {
  Brokers,
  AuthenticateError,
  Client,
  Connection
} from '../../aedes'
import Aedes, { AedesOptions, createBroker } from '../../aedes'
import type { AedesPublishPacket, ConnackPacket, ConnectPacket, PingreqPacket, PublishPacket, PubrelPacket, Subscription, SubscribePacket, UnsubscribePacket } from '../../types/packet'
import { expectType } from 'tsd'

// Test for createBroker function
expectType<(options?: AedesOptions) => Aedes>(createBroker)

// Aedes server
let broker = createBroker()
expectType<Aedes>(broker)

broker = new Aedes({
  id: 'aedes',
  concurrency: 100,
  heartbeatInterval: 60000,
  connectTimeout: 30000,
  maxClientsIdLength: 23,
  keepaliveLimit: 0,
  preConnect: (client: Client, packet: ConnectPacket, callback) => {
    if (client.req) {
      callback(new Error('not websocket stream'), false)
    }
    if (client.conn instanceof Socket && client.conn.remoteAddress === '::1') {
      callback(null, true)
    } else {
      callback(new Error('connection error'), false)
    }
  },
  authenticate: (
    client: Client,
    username: Readonly<string | undefined>,
    password: Readonly<Buffer | undefined>,
    callback
  ) => {
    if (
      username === 'test' &&
      password === Buffer.from('test') &&
      client.version === 4
    ) {
      callback(null, true)
    } else {
      const error = new Error() as AuthenticateError
      error.returnCode = 1

      callback(error, false)
    }
  },
  authorizePublish: (
    client: Client | null,
    packet: PublishPacket,
    callback
  ) => {
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
    } else if (
      packet.topic === 'aaaa' &&
      client.id === 'I should not see this either'
    ) {
      return
    }

    if (packet.topic === 'bbb') {
      packet.payload = Buffer.from('overwrite packet payload')
    }

    return packet
  },
  published: (packet: AedesPublishPacket, client: Client, callback) => {
    callback(null)
    callback(new Error())
  }
})

expectType<Aedes>(broker)

expectType<Readonly<Brokers>>(broker.brokers)

expectType<Aedes>(broker.on('closed', () => {}))
expectType<Aedes>(broker.on('client', (client: Client) => {}))
expectType<Aedes>(broker.on('clientReady', (client: Client) => {}))
expectType<Aedes>(broker.on('clientDisconnect', (client: Client) => {}))
expectType<Aedes>(broker.on('keepaliveTimeout', (client: Client) => {}))
expectType<Aedes>(
  broker.on('clientError', (client: Client, error: Error) => {})
)
expectType<Aedes>(
  broker.on('connectionError', (client: Client, error: Error) => {})
)
expectType<Aedes>(
  broker.on('connackSent', (packet: ConnackPacket, client: Client) => {})
)
expectType<Aedes>(
  broker.on('ping', (packet: PingreqPacket, client: Client) => {})
)
expectType<Aedes>(
  broker.on(
    'publish',
    (packet: AedesPublishPacket, client: Client | null) => {}
  )
)
expectType<Aedes>(
  broker.on('ack', (packet: PublishPacket | PubrelPacket, client: Client) => {})
)
expectType<Aedes>(
  broker.on('subscribe', (subscriptions: Subscription[], client: Client) => {})
)
expectType<Aedes>(
  broker.on('unsubscribe', (unsubscriptions: string[], client: Client) => {})
)

expectType<void>(
  broker.publish({} as PublishPacket, (error?: Error) => {
    if (error) {
      console.error(error)
    }
  })
)

expectType<void>(
  broker.subscribe(
    'topic',
    (packet: AedesPublishPacket, callback: () => void) => {},
    () => {}
  )
)

expectType<void>(
  broker.unsubscribe(
    'topic',
    (packet: AedesPublishPacket, callback: () => void) => {},
    () => {}
  )
)

expectType<void>(broker.close())
expectType<void>(broker.close(() => {}))

// Aedes client
const client = broker.handle({} as Connection, {} as IncomingMessage)
const client2 = broker.handle({} as Connection)

expectType<Client>(client)
expectType<Client>(client2)

expectType<Connection>(client.conn)
expectType<IncomingMessage>(client.req!)

expectType<Client>(client.on('connected', () => {}))
expectType<Client>(
  client.on('error', (error: Error) => {
    if (error) {
      console.error(error)
    }
  })
)

expectType<void>(
  client.publish({} as PublishPacket, (error?: Error) => {
    if (error) {
      console.error(error)
    }
  })
)
expectType<void>(client.publish({} as PublishPacket))

expectType<void>(
  client.subscribe({} as Subscription, (error?: Error) => {
    if (error) {
      console.error(error)
    }
  })
)
expectType<void>(client.subscribe({} as Subscription))
expectType<void>(client.subscribe([] as Subscription[]))
expectType<void>(client.subscribe({} as SubscribePacket))

expectType<void>(
  client.unsubscribe({} as Subscription, (error?: Error) => {
    if (error) {
      console.error(error)
    }
  })
)
expectType<void>(client.unsubscribe({} as Subscription))
expectType<void>(client.unsubscribe([] as Subscription[]))
expectType<void>(client.unsubscribe({} as UnsubscribePacket))

expectType<void>(client.emptyOutgoingQueue())
expectType<void>(client.emptyOutgoingQueue(() => {}))

expectType<void>(client.close())
expectType<void>(client.close(() => {}))
