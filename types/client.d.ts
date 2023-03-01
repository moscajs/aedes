import { IncomingMessage } from 'node:http'
import {
  PublishPacket,
  SubscribePacket,
  Subscription,
  Subscriptions,
  UnsubscribePacket
} from './packet'
import { Connection } from './instance'
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
