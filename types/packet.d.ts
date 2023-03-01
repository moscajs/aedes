import { AedesPacket } from 'aedes-packet'
import {
  IConnackPacket,
  IConnectPacket,
  IPingreqPacket,
  IPublishPacket,
  IPubrelPacket,
  ISubscribePacket,
  ISubscription,
  IUnsubscribePacket
} from 'mqtt-packet'
import { Client } from './client'

export type SubscribePacket = ISubscribePacket & { cmd: 'subscribe' };
export type UnsubscribePacket = IUnsubscribePacket & { cmd: 'unsubscribe' };
export type Subscription = ISubscription & { clientId?: Client['id'] };
export type Subscriptions = { subscriptions: Subscription[] };

export type PublishPacket = IPublishPacket & { cmd: 'publish' };

export type ConnectPacket = IConnectPacket & { cmd: 'connect' };
export type ConnackPacket = IConnackPacket & { cmd: 'connack' };

export type PubrelPacket = IPubrelPacket & { cmd: 'pubrel' };
export type PingreqPacket = IPingreqPacket & { cmd: 'pingreq' };

export type AedesPublishPacket = PublishPacket & AedesPacket;
