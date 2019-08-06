/* eslint no-unused-vars: 0 */
/* eslint no-undef: 0 */
/* eslint space-infix-ops: 0 */

/// <reference types="node" />

import { IPublishPacket, ISubscribePacket, ISubscription, IUnsubscribePacket } from 'mqtt-packet'
import { Duplex } from 'stream'
import EventEmitter = NodeJS.EventEmitter

declare function aedes (options?: aedes.AedesOptions): aedes.Aedes

// eslint-disable-next-line no-redeclare
declare namespace aedes {
  export enum AuthErrorCode {
    UNNACCEPTABLE_PROTOCOL = 1,
    IDENTIFIER_REJECTED = 2,
    SERVER_UNAVAILABLE = 3,
    BAD_USERNAME_OR_PASSWORD = 4
  }

  export interface Client extends EventEmitter {
    id: string
    clean: boolean

    on (event: 'error', cb: (err: Error) => void): this

    publish (message: IPublishPacket, callback?: () => void): void
    subscribe (
      subscriptions: ISubscription | ISubscription[] | ISubscribePacket,
      callback?: () => void
    ): void
    unsubscribe (topicObjects: ISubscription | ISubscription[], callback?: () => void): void
    close (callback?: () => void): void
  }

  export type PreConnectCallback = (client: Client) => boolean

  export type AuthenticateError = Error & { returnCode: AuthErrorCode }

  export type AuthenticateCallback = (
    client: Client,
    username: string,
    password: string,
    done: (err: AuthenticateError | null, success: boolean | null) => void
  ) => void

  export type AuthorizePublishCallback = (client: Client, packet: IPublishPacket, done: (err?: Error | null) => void) => void

  export type AuthorizeSubscribeCallback = (client: Client, subscription: ISubscription, done: (err: Error | null, subscription?: ISubscription | null) => void) => void

  export type AuthorizeForwardCallback = (client: Client, packet: IPublishPacket) => IPublishPacket | null | void

  export type PublishedCallback = (packet: IPublishPacket, client: Client, done: () => void) => void

  export interface AedesOptions {
    mq?: any
    persistence?: any
    concurrency?: number
    heartbeatInterval?: number
    connectTimeout?: number
    preConnect?: PreConnectCallback
    authenticate?: AuthenticateCallback
    authorizePublish?: AuthorizePublishCallback
    authorizeSubscribe?: AuthorizeSubscribeCallback
    authorizeForward?: AuthorizeForwardCallback
    published?: PublishedCallback
  }

  export interface Aedes extends EventEmitter {
    handle: (stream: Duplex) => void

    preConnect: PreConnectCallback
    authenticate: AuthenticateCallback
    authorizePublish: AuthorizePublishCallback
    authorizeSubscribe: AuthorizeSubscribeCallback
    authorizeForward: AuthorizeForwardCallback
    published: PublishedCallback

    on (event: 'closed', cb: () => void): this
    on (event: 'client' | 'clientReady' | 'clientDisconnect' | 'keepaliveTimeout' | 'connackSent', cb: (client: Client) => void): this
    on (event: 'clientError' | 'connectionError', cb: (client: Client, error: Error) => void): this
    on (event: 'ping' | 'publish' | 'ack', cb: (packet: any, client: Client) => void): this
    on (event: 'subscribe' | 'unsubscribe', cb: (subscriptions: ISubscription | ISubscription[] | ISubscribePacket, client: Client) => void): this

    publish (packet: IPublishPacket & { topic: string | Buffer }, done: () => void): void
    subscribe (topic: string, callback: (packet: ISubscribePacket, cb: () => void) => void, done: () => void): void
    unsubscribe (
      topic: string,
      callback: (packet: IUnsubscribePacket, cb: () => void) => void,
      done: () => void
    ): void
    close (callback?: () => void): void
  }

  export function Server (options?: aedes.AedesOptions): aedes.Aedes
}

export = aedes
