import { IncomingMessage } from 'node:http'
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
  emptyOutgoingQueue(callback?: () => void): void;
}
