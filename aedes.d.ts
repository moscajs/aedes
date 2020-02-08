/* eslint no-unused-vars: 0 */
/* eslint no-undef: 0 */
/* eslint space-infix-ops: 0 */

/// <reference types="node" />

import { IPublishPacket, ISubscribePacket, ISubscription, IUnsubscribePacket } from 'mqtt-packet'
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
    BAD_USERNAME_OR_PASSWORD = 4
  }

  type PreConnectHandler = (client: Client, callback: (err: Error | null, success: boolean) => void) => void

  type AuthenticateError = Error & { returnCode: AuthErrorCode }

  type AuthenticateHandler = (
    client: Client,
    username: string,
    password: string,
    done: (err: AuthenticateError | null, success: boolean | null) => void
  ) => void

  type AuthorizePublishHandler = (client: Client, packet: IPublishPacket, callback: (err?: Error | null) => void) => void

  type AuthorizeSubscribeHandler = (client: Client, subscription: ISubscription, callback: (err: Error | null, subscription?: ISubscription | null) => void) => void

  type AuthorizeForwardHandler = (client: Client, packet: IPublishPacket) => IPublishPacket | null | void

  type PublishedHandler = (packet: IPublishPacket, client: Client, callback: (err?: Error | null) => void) => void

  interface AedesOptions {
    mq?: any
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
  }
  interface Client extends EventEmitter {
    id: string
    clean: boolean
    conn: Socket
    req?: IncomingMessage

    on (event: 'connected', callback: () => void): this
    on (event: 'error', callback: (error: Error) => void): this

    publish (message: IPublishPacket, callback?: (error?: Error) => void): void
    subscribe (
      subscriptions: ISubscription | ISubscription[] | ISubscribePacket,
      callback?: (error?: Error) => void
    ): void
    unsubscribe (topicObjects: ISubscription | ISubscription[], callback?: (error?: Error) => void): void
    close (callback?: () => void): void
  }

  interface Aedes extends EventEmitter {
    handle: (stream: Duplex) => void

    on (event: 'closed', callback: () => void): this
    on (event: 'client' | 'clientReady' | 'clientDisconnect' | 'keepaliveTimeout' | 'connackSent', callback: (client: Client) => void): this
    on (event: 'clientError' | 'connectionError', callback: (client: Client, error: Error) => void): this
    on (event: 'ping' | 'publish' | 'ack', callback: (packet: any, client: Client) => void): this
    on (event: 'subscribe' | 'unsubscribe', callback: (subscriptions: ISubscription | ISubscription[] | ISubscribePacket, client: Client) => void): this

    publish (
      packet: IPublishPacket & { topic: string | Buffer },
      callback: () => void
    ): void
    subscribe (
      topic: string,
      deliverfunc: (packet: IPublishPacket, callback: () => void) => void,
      callback: () => void
    ): void
    unsubscribe (
      topic: string,
      deliverfunc: (packet: IPublishPacket, callback: () => void) => void,
      callback: () => void
    ): void
    close (callback?: () => void): void
  }

  function Server (options?: aedes.AedesOptions): aedes.Aedes
}

export = aedes
