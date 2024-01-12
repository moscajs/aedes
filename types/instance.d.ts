import { Duplex } from 'node:stream'
import { Socket } from 'node:net'
import { IncomingMessage } from 'http'
import { Client } from './client'
import type {
  AedesPublishPacket,
  ConnectPacket,
  ConnackPacket,
  Subscription,
  PingreqPacket,
  PublishPacket,
  PubrelPacket
} from './packet'
import { EventEmitter } from 'node:events'

type LastHearthbeatTimestamp = Date;

export interface Brokers {
  [brokerId: string]: LastHearthbeatTimestamp;
}

export type Connection = Duplex | Socket;

/* eslint no-unused-vars: 0 */
export const enum AuthErrorCode {
  UNNACCEPTABLE_PROTOCOL = 1,
  IDENTIFIER_REJECTED = 2,
  SERVER_UNAVAILABLE = 3,
  BAD_USERNAME_OR_PASSWORD = 4,
  NOT_AUTHORIZED = 5,
}

export type AuthenticateError = Error & { returnCode: AuthErrorCode };

type PreConnectHandler = (
  client: Client,
  packet: ConnectPacket,
  callback: (error: Error | null, success: boolean) => void
) => void;

type AuthenticateHandler = (
  client: Client,
  username: Readonly<string | undefined>,
  password: Readonly<Buffer | undefined>,
  done: (error: AuthenticateError | null, success: boolean | null) => void
) => void;

type AuthorizePublishHandler = (
  client: Client | null,
  packet: PublishPacket,
  callback: (error?: Error | null) => void
) => void;

type AuthorizeSubscribeHandler = (
  client: Client,
  subscription: Subscription,
  callback: (error: Error | null, subscription?: Subscription | null) => void
) => void;

type AuthorizeForwardHandler = (
  client: Client,
  packet: AedesPublishPacket
) => AedesPublishPacket | null | void;

type PublishedHandler = (
  packet: AedesPublishPacket,
  client: Client,
  callback: (error?: Error | null) => void
) => void;

export interface AedesOptions {
  mq?: any;
  id?: string;
  persistence?: any;
  concurrency?: number;
  heartbeatInterval?: number;
  connectTimeout?: number;
  keepaliveLimit?: number;
  queueLimit?: number;
  maxClientsIdLength?: number;
  preConnect?: PreConnectHandler;
  authenticate?: AuthenticateHandler;
  authorizePublish?: AuthorizePublishHandler;
  authorizeSubscribe?: AuthorizeSubscribeHandler;
  authorizeForward?: AuthorizeForwardHandler;
  published?: PublishedHandler;
}

export default class Aedes extends EventEmitter {
  id: Readonly<string>
  connectedClients: Readonly<number>
  closed: Readonly<boolean>
  brokers: Readonly<Brokers>

  constructor(option?: AedesOptions);
  handle: (stream: Connection, request?: IncomingMessage) => Client

  on(event: 'closed', listener: () => void): this;
  on(
    event: 'client' | 'clientReady' | 'clientDisconnect' | 'keepaliveTimeout',
    listener: (client: Client) => void
  ): this;

  on(
    event: 'clientError' | 'connectionError',
    listener: (client: Client, error: Error) => void
  ): this;

  on(
    event: 'connackSent',
    listener: (packet: ConnackPacket, client: Client) => void
  ): this;

  on(
    event: 'ping',
    listener: (packet: PingreqPacket, client: Client) => void
  ): this;

  on(
    event: 'publish',
    listener: (packet: AedesPublishPacket, client: Client | null) => void
  ): this;

  on(
    event: 'ack',
    listener: (packet: PublishPacket | PubrelPacket, client: Client) => void
  ): this;

  on(
    event: 'subscribe',
    listener: (subscriptions: Subscription[], client: Client) => void
  ): this;

  on(
    event: 'unsubscribe',
    listener: (unsubscriptions: string[], client: Client) => void
  ): this;

  publish(packet: PublishPacket, callback: (error?: Error) => void): void;
  subscribe(
    topic: string,
    deliverfunc: (packet: AedesPublishPacket, callback: () => void) => void,
    callback: () => void
  ): void;

  unsubscribe(
    topic: string,
    deliverfunc: (packet: AedesPublishPacket, callback: () => void) => void,
    callback: () => void
  ): void;

  close(callback?: () => void): void;

  preConnect: PreConnectHandler
  authenticate: AuthenticateHandler
  authorizePublish: AuthorizePublishHandler
  authorizeSubscribe: AuthorizeSubscribeHandler
  authorizeForward: AuthorizeForwardHandler
  published: PublishedHandler
}
