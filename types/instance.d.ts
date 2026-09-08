import { Duplex } from 'node:stream'
import { Socket } from 'node:net'
import { IncomingMessage } from 'node:http'
import { IAuthPacket } from 'mqtt-packet'
import { Client } from './client.js'
import type {
  AedesPublishPacket,
  ConnectPacket,
  ConnackPacket,
  Subscription,
  PingreqPacket,
  PublishPacket,
  PubrelPacket
} from './packet.js'
import { EventEmitter } from 'node:events'

type LastHearthbeatTimestamp = Date

export interface Brokers {
  [brokerId: string]: LastHearthbeatTimestamp;
}

export type Connection = Duplex | Socket

/* eslint no-unused-vars: 0 */
export const enum AuthErrorCode {
  UNNACCEPTABLE_PROTOCOL = 1,
  IDENTIFIER_REJECTED = 2,
  SERVER_UNAVAILABLE = 3,
  BAD_USERNAME_OR_PASSWORD = 4,
  NOT_AUTHORIZED = 5,
}

export type AuthenticateError = Error & { returnCode: AuthErrorCode, serverReference?: string }

// MQTT 5.0 CONNACK reason codes a rejection may carry (the failure subset from
// Table 3-1). A hook returning any code NOT valid on a CONNACK — a success/< 0x80
// code, or a real reason code that isn't in this set (e.g. 0x8E, 0x93) — is clamped
// to 0x87 at runtime.
export const enum ConnackReasonCode {
  UNSPECIFIED_ERROR = 0x80,
  MALFORMED_PACKET = 0x81,
  PROTOCOL_ERROR = 0x82,
  IMPLEMENTATION_SPECIFIC_ERROR = 0x83,
  UNSUPPORTED_PROTOCOL_VERSION = 0x84,
  CLIENT_IDENTIFIER_NOT_VALID = 0x85,
  BAD_USERNAME_OR_PASSWORD = 0x86,
  NOT_AUTHORIZED = 0x87,
  SERVER_UNAVAILABLE = 0x88,
  SERVER_BUSY = 0x89,
  BANNED = 0x8A,
  BAD_AUTHENTICATION_METHOD = 0x8C,
  TOPIC_NAME_INVALID = 0x90,
  PACKET_TOO_LARGE = 0x95,
  QUOTA_EXCEEDED = 0x97,
  PAYLOAD_FORMAT_INVALID = 0x99,
  RETAIN_NOT_SUPPORTED = 0x9A,
  QOS_NOT_SUPPORTED = 0x9B,
  USE_ANOTHER_SERVER = 0x9C,
  SERVER_MOVED = 0x9D,
  CONNECTION_RATE_EXCEEDED = 0x9F,
}

// MQTT 5.0 Enhanced Authentication (§4.12). An error rejects the CONNECT; its
// optional reasonCode / reasonString are surfaced on the CONNACK.
export type EnhancedAuthError = Error & { reasonCode?: ConnackReasonCode, reasonString?: string, serverReference?: string }

// Properties a hook may attach to a challenge AUTH. AUTH allows only Reason String
// and User Property (§3.15.2.2); Authentication Method / Data are owned by aedes,
// so they are excluded here. Subject to the client's Request Problem Information.
export type EnhancedAuthProperties = Omit<NonNullable<IAuthPacket['properties']>, 'authenticationMethod' | 'authenticationData'>

// One step of the enhanced-auth exchange, as a discriminated union on `status`.
// `status: 'challenge'` sends the client another AUTH challenge (carrying `data` /
// `properties`); `status: 'accept'` accepts the connection (any `data` becomes the
// CONNACK Authentication Data). `status` is a distinct field from the `done`
// callback in the hook signature, and TS narrows `data`/`properties` per branch.
export type EnhancedAuthResult =
  | { status: 'challenge'; data?: Buffer; properties?: EnhancedAuthProperties }
  | { status: 'accept'; data?: Buffer; properties?: EnhancedAuthProperties }

type PreConnectHandler = (
  client: Client,
  packet: ConnectPacket,
  callback: (error: Error | null, success: boolean) => void
) => void

type AuthenticateHandler = (
  client: Client,
  username: Readonly<string | undefined>,
  password: Readonly<Buffer | undefined>,
  done: (error: AuthenticateError | null, success: boolean | null) => void
) => void

// MQTT 5.0 Enhanced Authentication (§4.12): drives the AUTH-packet exchange for a
// CONNECT carrying an Authentication Method. Called once per round with the
// client's latest Authentication Data.
type AuthenticateEnhancedHandler = (
  client: Client,
  method: Readonly<string>,
  data: Readonly<Buffer | undefined>,
  done: (error: EnhancedAuthError | null, result?: EnhancedAuthResult | null) => void
) => void

type AuthorizePublishHandler = (
  client: Client | null,
  packet: PublishPacket,
  callback: (error?: Error | null) => void
) => void

type AuthorizeSubscribeHandler = (
  client: Client,
  subscription: Subscription,
  callback: (error: Error | null, subscription?: Subscription | null) => void
) => void

type AuthorizeForwardHandler = (
  client: Client,
  packet: AedesPublishPacket
) => AedesPublishPacket | null | void

type PublishedHandler = (
  packet: AedesPublishPacket,
  client: Client,
  callback: (error?: Error | null) => void
) => void

type DecodeProtocolHandler = (
  client: Client,
  buffer: Buffer
) => any

export interface AedesOptions {
  mq?: any;
  id?: string;
  persistence?: any;
  concurrency?: number;
  heartbeatInterval?: number;
  connectTimeout?: number;
  drainTimeout?: number; // default: 60000 (60 seconds)
  keepaliveLimit?: number;
  queueLimit?: number;
  maxClientsIdLength?: number;
  maxTopicLevels?: number; // default: 100, clamped to [1, 100]
  decodeProtocol?: DecodeProtocolHandler;
  trustProxy?: boolean;
  trustedProxies?: string[];
  // MQTT 5.0 broker limits, advertised in CONNACK.
  topicAliasMaximum?: number; // max inbound topic alias; 0 disables (default: 0)
  maximumPacketSize?: number; // max accepted packet size in bytes; 0 = no limit (default: 0)
  receiveMaximum?: number; // advertised max in-flight QoS 1/2; 0 = not advertised (default: 0)
  sessionExpiryIntervalLimit?: number; // clamp (seconds) on requested Session Expiry Interval; 0 = no cap (default: 0)
  pendingSessionsLimit?: number; // cap on pending session-expiry / delayed-will entries; 0 = unlimited (default: 0)
  responseInformation?: string | null | ((client: Client) => string | undefined); // MQTT 5.0 Response Information returned in CONNACK on Request Response Information (null = disabled, the default)
  maxAuthRounds?: number; // MQTT 5.0 enhanced auth: max challenge/response rounds (default: 8)
  preConnect?: PreConnectHandler;
  authenticate?: AuthenticateHandler;
  authenticateEnhanced?: AuthenticateEnhancedHandler | null;
  authorizePublish?: AuthorizePublishHandler;
  authorizeSubscribe?: AuthorizeSubscribeHandler;
  authorizeForward?: AuthorizeForwardHandler;
  published?: PublishedHandler;
}

export class Aedes extends EventEmitter {
  id: Readonly<string>
  connectedClients: Readonly<number>
  closed: Readonly<boolean>
  brokers: Readonly<Brokers>

  constructor (option?: AedesOptions)
  handle: (stream: Connection, request?: IncomingMessage) => Client

  on (event: 'closed', listener: () => void): this
  on (
    event: 'client' | 'clientReady' | 'clientDisconnect' | 'keepaliveTimeout' | 'sessionExpired',
    listener: (client: Client) => void
  ): this

  on (
    event: 'sessionLimitReached',
    listener: (
      client: Client,
      info: { reason: 'sessionExpiry' | 'willDelay'; limit: number }
    ) => void
  ): this

  on (
    event: 'willDropped',
    listener: (client: Client, will: NonNullable<ConnectPacket['will']>) => void
  ): this

  on (
    event: 'clientError' | 'connectionError',
    listener: (client: Client, error: Error) => void
  ): this

  on (
    event: 'connackSent',
    listener: (packet: ConnackPacket, client: Client) => void
  ): this

  on (
    event: 'ping',
    listener: (packet: PingreqPacket, client: Client) => void
  ): this

  on (
    event: 'publish',
    listener: (packet: AedesPublishPacket, client: Client | null) => void
  ): this

  on (
    event: 'ack',
    listener: (packet: PublishPacket | PubrelPacket, client: Client) => void
  ): this

  on (
    event: 'subscribe',
    listener: (subscriptions: Subscription[], client: Client) => void
  ): this

  on (
    event: 'unsubscribe',
    listener: (unsubscriptions: string[], client: Client) => void
  ): this

  listen (): Promise<void>

  static createBroker (option?: AedesOptions): Promise<Aedes>

  publish (packet: PublishPacket, callback: (error?: Error) => void): void
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

  preConnect: PreConnectHandler
  authenticate: AuthenticateHandler
  authenticateEnhanced: AuthenticateEnhancedHandler | null
  authorizePublish: AuthorizePublishHandler
  authorizeSubscribe: AuthorizeSubscribeHandler
  authorizeForward: AuthorizeForwardHandler
  published: PublishedHandler
}
