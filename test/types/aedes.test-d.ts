import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type {
  Brokers,
  AuthenticateError,
  EnhancedAuthError,
  EnhancedAuthResult,
  Client,
  Connection
} from '../../aedes.js'
import { Aedes } from '../../aedes.js'
import type { AedesPublishPacket, ConnackPacket, ConnectPacket, PingreqPacket, PublishPacket, PubrelPacket, Subscription, SubscribePacket, UnsubscribePacket } from '../../types/packet.js'
import { expectType, expectError, expectAssignable } from 'tsd'

// Aedes server
expectType<Promise<Aedes>>(Aedes.createBroker())

const broker = new Aedes({
  id: 'aedes',
  concurrency: 100,
  heartbeatInterval: 60000,
  connectTimeout: 30000,
  maxAuthRounds: 8,
  maxClientsIdLength: 23,
  keepaliveLimit: 0,
  trustProxy: true,
  trustedProxies: ['127.0.0.1'],
  decodeProtocol: (client: Client, buffer: Buffer) => buffer,
  topicAliasMaximum: 10,
  maximumPacketSize: 1048576,
  receiveMaximum: 20,
  sessionExpiryIntervalLimit: 86400,
  pendingSessionsLimit: 10000,
  responseInformation: (client: Client) => 'resp/' + client.id,
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
  authenticateEnhanced: (
    client: Client,
    method: Readonly<string>,
    data: Readonly<Buffer | undefined>,
    done
  ) => {
    if (method !== 'SCRAM-SHA-256') {
      const error = new Error('bad method') as EnhancedAuthError
      error.reasonCode = 0x8c
      done(error)
    } else if (data?.toString() === 'client-final') {
      done(null, { status: 'accept', data: Buffer.from('server-final') })
    } else {
      done(null, { status: 'challenge', data: Buffer.from('server-challenge'), properties: { reasonString: 'continue' } })
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

// responseInformation accepts a static string and the null disable sentinel too,
// not just the (client) => string function arm exercised above.
expectType<Aedes>(new Aedes({ responseInformation: 'resp/base' }))
expectType<Aedes>(new Aedes({ responseInformation: null }))

expectType<Readonly<Brokers>>(broker.brokers)

// [#833] maxAuthRounds is a public constructor option (not re-exposed as a mutable
// instance property, matching connectTimeout / maximumPacketSize / etc.).
expectType<Aedes>(new Aedes({ maxAuthRounds: 32 }))

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
expectType<Aedes>(
  broker.on('sessionExpired', (client: Client) => {})
)
expectType<Aedes>(
  broker.on(
    'sessionLimitReached',
    (client: Client, info: { reason: 'sessionExpiry' | 'willDelay'; limit: number }) => {}
  )
)
expectType<Aedes>(
  broker.on('willDropped', (client: Client, will: NonNullable<ConnectPacket['will']>) => {})
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

// MQTT 5.0 server-initiated disconnect: opts form, opts+callback, and the
// callback-only overload.
expectType<void>(client.disconnect())
expectType<void>(client.disconnect(() => {}))
expectType<void>(client.disconnect({ reasonCode: 0x8b }))
expectType<void>(
  client.disconnect(
    { reasonCode: 0x8b, properties: { reasonString: 'server shutting down' } },
    () => {}
  )
)

// [#833] EnhancedAuthResult shape checks: a well-formed result is assignable...
expectAssignable<EnhancedAuthResult>({ status: 'accept' })
expectAssignable<EnhancedAuthResult>({ status: 'challenge', data: Buffer.from('x'), properties: { reasonString: 'go' } })
// ...but malformed ones are rejected.
expectError<EnhancedAuthResult>({ status: 'yes' }) // status must be 'accept' | 'challenge'
expectError<EnhancedAuthResult>({ status: 'accept', data: 'not-a-buffer' }) // data must be a Buffer
expectError<EnhancedAuthResult>({ data: Buffer.from('x') }) // status is required (discriminator)
// AUTH allows only Reason String / User Property — Authentication Method / Data
// are owned by aedes and not accepted on the hook result properties.
expectError<EnhancedAuthResult>({ status: 'challenge', properties: { authenticationMethod: 'X' } })
