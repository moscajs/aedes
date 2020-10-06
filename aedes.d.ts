/* eslint no-unused-vars: 0 */
/* eslint no-undef: 0 */
/* eslint space-infix-ops: 0 */

/// <reference types="node" />

import { IConnackPacket, IConnectPacket, IPingreqPacket, IPublishPacket, IPubrelPacket, ISubscribePacket, ISubscription, IUnsubscribePacket } from 'mqtt-packet'
import { AedesPacket } from 'aedes-packet'
import { Duplex } from 'stream'
import { Socket } from 'net'
import { IncomingMessage } from 'http'
import EventEmitter = NodeJS.EventEmitter

declare function aedes (options?: aedes.AedesOptions): aedes.Aedes

// eslint-disable-next-line no-redeclare
declare namespace aedes {
  enum AuthErrorCode {
    UNNACCEPTABLE_PROTOCOL = 1,
    IDENTIFIER_REJECTED = 2,
    SERVER_UNAVAILABLE = 3,
    BAD_USERNAME_OR_PASSWORD = 4,
    NOT_AUTHORIZED = 5
  }

  type Connection = Duplex | Socket

  type Subscription = ISubscription
  type Subscriptions = { subscriptions: Subscription[] }
  type SubscribePacket = ISubscribePacket & { cmd: 'subscribe' }
  type UnsubscribePacket = IUnsubscribePacket & { cmd: 'unsubscribe' }

  type PublishPacket = IPublishPacket & { cmd: 'publish' }
  type AedesPublishPacket = PublishPacket & AedesPacket

  type ConnectPacket = IConnectPacket & { cmd: 'connect' }
  type ConnackPacket = IConnackPacket & { cmd: 'connack' }
  type PubrelPacket = IPubrelPacket & { cmd: 'pubrel' }
  type PingreqPacket = IPingreqPacket & { cmd: 'pingreq' }

  type PreConnectHandler = (client: Client, packet: IConnectPacket, callback: (error: Error | null, success: boolean) => void) => void

  type AuthenticateError = Error & { returnCode: AuthErrorCode }

  type AuthenticateHandler = (
    client: Client,
    username: string,
    password: Buffer,
    done: (error: AuthenticateError | null, success: boolean | null) => void
  ) => void

  type AuthorizePublishHandler = (client: Client, packet: PublishPacket, callback: (error?: Error | null) => void) => void

  type AuthorizeSubscribeHandler = (client: Client, subscription: Subscription, callback: (error: Error | null, subscription?: Subscription | null) => void) => void

  type AuthorizeForwardHandler = (client: Client, packet: AedesPublishPacket) => AedesPublishPacket | null | void

  type PublishedHandler = (packet: AedesPublishPacket, client: Client, callback: (error?: Error | null) => void) => void

  interface AedesOptions {
    mq?: any
    id?: string
    persistence?: any
    concurrency?: number
    heartbeatInterval?: number
    connectTimeout?: number
    preConnect?: PreConnectHandler
    authenticate?: AuthenticateHandler
    authorizePublish?: AuthorizePublishHandler
    authorizeSubscribe?: AuthorizeSubscribeHandler
    authorizeForward?: AuthorizeForwardHandler
    published?: PublishedHandler
    queueLimit?: number
    maxClientsIdLength?: number
  }
  interface Client extends EventEmitter {
    id: string
    clean: boolean
    version: number
    conn: Connection
    req?: IncomingMessage
    connecting: boolean
    connected: boolean
    closed: boolean

    on (event: 'connected', listener: () => void): this
    on (event: 'error', listener: (error: Error) => void): this

    publish (message: PublishPacket, callback?: (error?: Error) => void): void
    subscribe (
      subscriptions: Subscriptions | Subscription | Subscription[] | SubscribePacket,
      callback?: (error?: Error) => void
    ): void
    unsubscribe (topicObjects: Subscriptions | Subscription | Subscription[] | UnsubscribePacket, callback?: (error?: Error) => void): void
    close (callback?: () => void): void
    emptyOutgoingQueue (callback?: () => void): void
  }

  interface Aedes extends EventEmitter {
    id: string
    connectedClients: number
    closed: boolean

    handle: (stream: Connection) => Client

    on (event: 'closed', listener: () => void): this
    on (event: 'client' | 'clientReady' | 'clientDisconnect' | 'keepaliveTimeout', listener: (client: Client) => void): this
    on (event: 'clientError' | 'connectionError', listener: (client: Client, error: Error) => void): this
    on (event: 'connackSent', listener: (packet: ConnackPacket, client: Client) => void): this
    on (event: 'ping', listener: (packet: PingreqPacket, client: Client) => void): this
    on (event: 'publish', listener: (packet: AedesPublishPacket, client: Client) => void): this
    on (event: 'ack', listener: (packet: PublishPacket | PubrelPacket, client: Client) => void): this
    on (event: 'subscribe', listener: (subscriptions: Subscription[], client: Client) => void): this
    on (event: 'unsubscribe', listener: (unsubscriptions: string[], client: Client) => void): this

    publish (
      packet: PublishPacket,
      callback: (error?: Error) => void
    ): void
    subscribe (
      topic: string,
      deliverfunc: (packet: AedesPublishPacket, callback: () => void) => void,
      callback: () => void
    ): void
    unsubscribe (
      topic: string,
      deliverfunc: (packet: AedesPublishPacket, callback: () => void) => void,
      callback: () => void
    ): void
    close (callback?: () => void): void
  }

  function Server (options?: aedes.AedesOptions): aedes.Aedes
}

export = aedes
