import { IncomingMessage } from 'node:http'
import { IDisconnectPacket } from 'mqtt-packet'
import {
  PublishPacket,
  SubscribePacket,
  Subscription,
  Subscriptions,
  UnsubscribePacket
} from './packet.js'
import { Connection } from './instance.js'
import { EventEmitter } from 'node:events'

export interface Client extends EventEmitter {
  id: Readonly<string>;
  clean: Readonly<boolean>;
  version: Readonly<number>;
  conn: Connection;
  req?: IncomingMessage;
  connecting: Readonly<boolean>;
  connected: Readonly<boolean>;
  closed: Readonly<boolean>;
  /**
   * MQTT 5.0: when the broker initiated the disconnect, the reason code sent to
   * the client (e.g. 0x8E session taken over, 0x8B server shutting down, 0x95
   * packet too large). `null` for a normal client-initiated disconnect.
   */
  disconnectReasonCode: Readonly<number | null>;
  /**
   * MQTT 5.0: the negotiated Session Expiry Interval in seconds (from CONNECT,
   * clamped to the broker's `sessionExpiryIntervalLimit`, and updated by a
   * DISCONNECT that carries the property). `0xFFFFFFFF` means never expires.
   */
  sessionExpiryInterval: Readonly<number>;
  /**
   * MQTT 5.0: the Maximum Packet Size (bytes) the client advertised it will
   * accept, or `undefined` if it advertised none. Advisory on the broker side.
   */
  maximumPacketSize: Readonly<number | undefined>;
  /**
   * MQTT 5.0: the Receive Maximum the client advertised (in-flight QoS 1/2
   * limit towards it); defaults to `65535`. Advisory on the broker side.
   */
  receiveMaximum: Readonly<number>;

  on(event: 'connected', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;

  publish(message: PublishPacket, callback?: (error?: Error) => void): void;
  subscribe(
    subscriptions:
    | Subscriptions
    | Subscription
    | Subscription[]
    | SubscribePacket,
    callback?: (error?: Error) => void
  ): void;
  unsubscribe(
    topicObjects:
    | Subscriptions
    | Subscription
    | Subscription[]
    | UnsubscribePacket,
    callback?: (error?: Error) => void
  ): void;
  close(callback?: () => void): void;
  /**
   * MQTT 5.0: server-initiated disconnect. For a v5 client a DISCONNECT packet
   * with the given reason code (and optional properties) is sent before closing;
   * for v3/v4 the connection is just closed.
   */
  disconnect(
    opts?: { reasonCode?: number; properties?: IDisconnectPacket['properties'] },
    callback?: () => void
  ): void;
  disconnect(callback: () => void): void;
  emptyOutgoingQueue(callback?: () => void): void;
}
