<!-- markdownlint-disable MD013 MD024 -->
# Aedes

- [Aedes](#aedes)
  - [new Aedes([options]) / new Aedes.Server([options])](#new-aedesoptions--new-aedesserveroptions)
  - [aedes.id](#aedesid)
  - [aedes.connectedClients](#aedesconnectedclients)
  - [aedes.closed](#aedesclosed)
  - [Event: client](#event-client)
  - [Event: clientReady](#event-clientready)
  - [Event: clientDisconnect](#event-clientdisconnect)
  - [Event: clientError](#event-clienterror)
  - [Event: connectionError](#event-connectionerror)
  - [Event: keepaliveTimeout](#event-keepalivetimeout)
  - [Event: publish](#event-publish)
  - [Event: ack](#event-ack)
  - [Event: ping](#event-ping)
  - [Event: subscribe](#event-subscribe)
  - [Event: unsubscribe](#event-unsubscribe)
  - [Event: connackSent](#event-connacksent)
  - [Event: closed](#event-closed)
  - [aedes.handle (stream)](#aedeshandle-stream)
  - [aedes.subscribe (topic, deliverfunc, callback)](#aedessubscribe-topic-deliverfunc-callback)
  - [aedes.unsubscribe (topic, deliverfunc, callback)](#aedesunsubscribe-topic-deliverfunc-callback)
  - [aedes.publish (packet, callback)](#aedespublish-packet-callback)
  - [aedes.close ([callback])](#aedesclose-callback)
  - [Handler: preConnect (client, packet, callback)](#handler-preconnect-client-packet-callback)
  - [Handler: authenticate (client, username, password, callback)](#handler-authenticate-client-username-password-callback)
  - [Handler: authorizePublish (client, packet, callback)](#handler-authorizepublish-client-packet-callback)
  - [Handler: authorizeSubscribe (client, subscription, callback)](#handler-authorizesubscribe-client-subscription-callback)
  - [Handler: authorizeForward (client, packet)](#handler-authorizeforward-client-packet)
  - [Handler: published (packet, client, callback)](#handler-published-packet-client-callback)

## new Aedes([options]) / new Aedes.Server([options])

- options `<object>`
  - `mq` [`<MQEmitter>`](../README.md#mqemitter) middleware used to deliver messages to subscribed clients. In a cluster environment it is used also to share messages between brokers instances. __Default__: `mqemitter`
  - `concurrency` `<number>` maximum number of concurrent messages delivered by `mq`. __Default__: `100`
  - `persistence` [`<Persistence>`](../README.md#persistence) middleware that stores _QoS > 0, retained, will_ packets and _subscriptions_. __Default__: `aedes-persistence` (_in memory_)
  - `queueLimit` `<number>` maximum number of queued messages before client session is established. If number of queued items exceeds, `connectionError` throws an error `Client queue limit reached`. __Default__: `42`
  - `maxClientsIdLength` option to override MQTT 3.1.0 clients Id length limit. __Default__: `23`
  - `heartbeatInterval` `<number>` an interval in millisconds at which server beats its health signal in `$SYS/<aedes.id>/heartbeat` topic. __Default__: `60000`
  - `id` `<string>` aedes broker unique identifier. __Default__: `uuidv4()`
  - `connectTimeout` `<number>` maximum waiting time in milliseconds waiting for a [`CONNECT`][CONNECT] packet. __Default__: `30000`
  - `keepaliveLimit` `<number>` maximum client keep alive time allowed, 0 means no limit. __Default__: `0`
- Returns `<Aedes>`

Create a new Aedes server.

Aedes is the class and function exposed by this module. It can be created by `Aedes()` or using `new Aedes()`. An variant `aedes.Server` is for TypeScript or ES modules.

## aedes.id

- `<string>` __Default__: `uuidv4()`

Server unique identifier.

## aedes.connectedClients

- `<number>` __Default__: 0

Number of connected clients in server.

## aedes.closed

- `<boolean>` __Default__: false

a read-only flag indicates if server is closed or not.

## Event: client

- `client` [`<Client>`](./Client.md)

Emitted when the `client` registers itself to server. The `client` is not ready yet. Its [`connecting`](./Client.md##clientconnecting) state equals to `true`.

Server publishes a SYS topic `$SYS/<aedes.id>/new/clients` to inform it registers the client into its registration pool. `client.id` is the payload.

## Event: clientReady

- `client` [`<Client>`](./Client.md)

Emitted when the `client` has received all its offline messages and be initialized. The `client` [`connected`](./Client.md##clientconnected) state equals to `true` and is ready for processing incoming messages.

## Event: clientDisconnect

- `client` [`<Client>`](./Client.md)

Emitted when a client disconnects.

Server publishes a SYS topic `$SYS/<aedes.id>/disconnect/clients` to inform it deregisters the client. `client.id` is the payload.

## Event: clientError

- `client` [`<Client>`](./Client.md)
- `error` `<Error>`

Emitted when an error occurs.

## Event: connectionError

- `client` [`<Client>`](./Client.md)
- `error` `<Error>`

Emitted when an error occurs. Unlike `clientError` it raises only when `client` is uninitialized.

## Event: keepaliveTimeout

- `client` [`<Client>`](./Client.md)

Emitted when timeout happes in the `client` keepalive.

## Event: publish

- `packet` `<aedes-packet>` & [`PUBLISH`][PUBLISH]
- `client` [`<Client>`](./Client.md) | `null`

Emitted when servers delivers the `packet` to subscribed `client`. If there are no clients subscribed to the `packet` topic, server still publish the `packet` and emit the event. `client` is `null` when `packet` is an internal message like aedes heartbeat message and LWT.

> _Note! `packet` belongs `aedes-packet` type. Some properties belongs to aedes internal, any changes on them will break aedes internal flow._

## Event: ack

- `packet` `<object>` [`PUBLISH`][PUBLISH] for QoS 1, [`PUBREL`][PUBREL] for QoS 2
- `client` [`<Client>`](./Client.md)

Emitted an QoS 1 or 2 acknowledgement when the `packet` successfully delivered to the `client`.

## Event: ping

- `packet` `<object>` [`PINGREQ`][PINGREQ]
- `client` [`<Client>`](./Client.md)

Emitted when `client` sends a `PINGREQ`.

## Event: subscribe

- `subscriptions` `<object>`
- `client` [`<Client>`](./Client.md)

Emitted when `client` successfully subscribe the `subscriptions` in server.

`subscriptions` is an array of `{ topic: topic, qos: qos }`. The array excludes duplicated topics and includes negated subscriptions where `qos` equals to `128`. See more on [authorizeSubscribe](#handler-authorizesubscribe-client-subscription-callback)

Server publishes a SYS topic `$SYS/<aedes.id>/new/subscribers` to inform a client successfully subscribed to one or more topics. The payload is a JSON that has `clientId` and `subs` props, `subs` equals to `subscriptions` array.

## Event: unsubscribe

- `unsubscriptions` `Array<string>`
- `client` [`<Client>`](./Client.md)

Emitted when `client` successfully unsubscribe the `subscriptions` in server.

`unsubscriptions` are an array of unsubscribed topics.

Server publishes a SYS topic `$SYS/<aedes.id>/new/unsubscribers` to inform a client successfully unsubscribed to one or more topics. The payload is a JSON that has `clientId` and `subs` props, `subs` equals to `unsubscriptions` array.

## Event: connackSent

- `packet` `<object>` [`CONNACK`][CONNACK]
- `client` [`<Client>`](./Client.md)

Emitted when server sends an acknowledge to `client`. Please refer to the MQTT specification for the explanation of returnCode object property in `CONNACK`.

## Event: closed

Emitted when server is closed.

## aedes.handle (stream)

- stream: `<net.Socket>` | `<stream.Duplex>`
- Returns: [`<Client>`](./Client.md)

A connection listener that pipe stream to aedes.

```js
const aedes = require('./aedes')()
const server = require('net').createServer(aedes.handle)
```

## aedes.subscribe (topic, deliverfunc, callback)

- topic: `<string>`
- deliverfunc: `<Function>` `(packet, cb) => void`
  - packet: `<aedes-packet>` & [`PUBLISH`][PUBLISH]
  - cb: `<Function>`
- callback: `<Function>`

Directly subscribe a `topic` in server side. Bypass [`authorizeSubscribe`](#handler-authorizesubscribe-client-subscription-callback)

The `topic` and `deliverfunc` is a compound key to differentiate the uniqueness of its subscription pool. `topic` could be the one that is existed, in this case `deliverfunc` will be invoked as well as [`SUBSCRIBE`][SUBSCRIBE] does.

`deliverfunc` supports backpressue.

In aedes internal, `deliverfunc` is a function that delivers messages to subscribed clients.

> _Note! `packet` belongs `aedes-packet` type. Some properties belongs to aedes internal, any changes on them will break aedes internal flow._

In general you would find most properities in `packet` is same as what the incoming [`PUBLISH`][PUBLISH] is. For sure `cmd` property in `packet` structure in `deliverfunc` must be `publish`.

> _Note! it requires `deliverfunc` to call `cb` before the function returns, otherwise some subscribed clients with  same `topic` will not receive messages._

`callback` is invoked when server successfully registers the subscription.

## aedes.unsubscribe (topic, deliverfunc, callback)

Reverse of [aedes.subscribe](#aedessubscribe-topic-deliverfunc-callback).

> _Note! the `deliverfunc` should be same as when `aedes.subscribe` does, otherwise the unsubscription will fail._

## aedes.publish (packet, callback)

- `packet` `<object>` [`PUBLISH`][PUBLISH]
- `callback` `<Function>` `(error) => void`
  - error `<Error>` | `null`

Directly deliver `packet` on behalf of server to subscribed clients. Bypass [`authorizePublish`](#handler-authorizepublish-client-packet-callback).

`callback` will be invoked with `error` arugments after finish.

## aedes.close ([callback])

- callback: `<Function>`

Close aedes server and disconnects all clients.

`callback` will be invoked when server is closed.

## Handler: preConnect (client, packet, callback)

- client: [`<Client>`](./Client.md)
- packet: `<object>` [`CONNECT`][CONNECT]
- callback: `<Function>` `(error, successful) => void`
  - error `<Error>` | `null`
  - successful `<boolean>`

Invoked when server receives a valid [`CONNECT`][CONNECT] packet. The packet can be modified.

`client` object is in default state. If invoked `callback` with no errors and `successful` be `true`, server will continue to establish a session.

Any `error` will be raised in `connectionError` event.

Some Use Cases:

1. Rate Limit / Throttle by `client.conn.remoteAddress`
2. Check `aedes.connectedClient` to limit maximum connections
3. IP blacklisting

```js
aedes.preConnect = function(client, packet, callback) {
  callback(null, client.conn.remoteAddress === '::1') {
}
```

```js
aedes.preConnect = function(client, packet, callback) {
  callback(new Error('connection error'), client.conn.remoteAddress !== '::1') {
}
```

## Handler: authenticate (client, username, password, callback)

- client: [`<Client>`](./Client.md)
- username: `<string>`
- password: `<Buffer>`
- callback: `<Function>` `(error, successful) => void`
  - error `<Error>` | `null`
  - successful `<boolean>`

Invoked after `preConnect`.

Server parses the [`CONNECT`][CONNECT] packet, initializes `client` object which set `client.id` to match the one in [`CONNECT`][CONNECT] packet and extract `username` and `password` as parameters for user-defined authentication flow.

If invoked `callback` with no errors and `successful` be `true`, server authenticates `client` and continues to setup the client session.

If authenticated, server acknowledges a [`CONNACK`][CONNACK] with `returnCode=0`, otherwise `returnCode=5`. Users could define the value between `2` and `5` by defining a `returnCode` property in `error` object.

```js
aedes.authenticate = function (client, username, password, callback) {
  callback(null, username === 'matteo')
}
```

```js
aedes.authenticate = function (client, username, password, callback) {
  var error = new Error('Auth error')
  error.returnCode = 4
  callback(error, null)
}
```

Please refer to [Connect Return Code](http://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html#_Table_3.1_-) to see their meanings.

## Handler: authorizePublish (client, packet, callback)

- client: [`<Client>`](./Client.md) | `null`
- packet: `<object>` [`PUBLISH`][PUBLISH]
- callback: `<Function>` `(error) => void`
  - error `<Error>` | `null`

Invoked when

1. publish LWT to all online clients
2. incoming client publish

`client` is `null` when aedes publishes obsolete LWT without connected clients

If invoked `callback` with no errors, server authorizes the packet otherwise emits `clientError` with `error`. If an `error` occurs the client connection will be closed, but no error is returned to the client (MQTT-3.3.5-2)

```js
aedes.authorizePublish = function (client, packet, callback) {
  if (packet.topic === 'aaaa') {
    return callback(new Error('wrong topic'))
  }
  if (packet.topic === 'bbb') {
    packet.payload = Buffer.from('overwrite packet payload')
  }
  callback(null)
}
```

By default `authorizePublish` throws error in case a client publish to topics with `$SYS/` prefix to prevent possible DoS (see [#597](https://github.com/moscajs/aedes/issues/597)). If you write your own implementation of `authorizePublish` we suggest you to add a check for this. Default implementation:

```js
function defaultAuthorizePublish (client, packet, callback) {
  if (packet.topic.startsWith($SYS_PREFIX)) {
    return callback(new Error($SYS_PREFIX + ' topic is reserved'))
  }
  callback(null)
}
```

## Handler: authorizeSubscribe (client, subscription, callback)

- client: [`<Client>`](./Client.md)
- subscription: `<object>`
- callback: `<Function>` `(error) => void`
  - error `<Error>` | `null`
  - subscription: `<object>` | `null`

Invoked when

1. restore subscriptions in non-clean session.
2. incoming client [`SUBSCRIBE`][SUBSCRIBE]

`subscription` is a dictionary object like `{ topic: hello, qos: 0 }`.

If invoked `callback` with no errors, server authorizes the packet otherwise emits `clientError` with `error`.

In general user should not touch the `subscription` and pass to callback, but server gives an option to change the subscription on-the-fly.

```js
aedes.authorizeSubscribe = function (client, sub, callback) {
  if (sub.topic === 'aaaa') {
    return callback(new Error('wrong topic'))
  }
  if (sub.topic === 'bbb') {
    // overwrites subscription
    sub.topic = 'foo'
    sub.qos = 1
  }
  callback(null, sub)
}
```

To negate a subscription, set the subscription to `null`. Aedes ignores the negated subscription and the `qos` in `SubAck` is set to `128` based on [MQTT 3.11 spec](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html#_Toc385349323):

```js
aedes.authorizeSubscribe = function (client, sub, callback) {
  // prohibited to subscribe 'aaaa' and suppress error
  callback(null, sub.topic === 'aaaa' ? null : sub)
}
```

## Handler: authorizeForward (client, packet)

- client: [`<Client>`](./Client.md)
- packet: `<aedes-packet>` & [`PUBLISH`][PUBLISH]
- Returns: `<aedes-packet>` | `null`

Invoked when

1. aedes sends retained messages when client reconnects
2. aedes pre-delivers subscribed message to clients

Return `null` will not forward `packet` to clients.

In general user should not touch the `packet` and return it what it is, but server gives an option to change the `packet` on-the-fly and forward it to clients.

> _Note! `packet` belongs `aedes-packet` type. Some properties belongs to aedes internal, any changes on them will break aedes internal flow._

```js
aedes.authorizeForward = function (client, packet) {
  if (packet.topic === 'aaaa' && client.id === "I should not see this") {
    return
  }
  if (packet.topic === 'bbb') {
    packet.payload = new Buffer('overwrite packet payload')
  }
  return packet
}
```

## Handler: published (packet, client, callback)

- packet: `<aedes-packet>` & [`PUBLISH`][PUBLISH]
- client: [`<Client>`](./Client.md)
- callback: `<Function>`

same as [`Event: publish`](#event-publish), but provides a backpressure functionality. TLDR; If you are doing operations on packets that MUST require finishing operations on a packet before handling the next one use this otherwise, expecially for long running operations, you should use [`Event: publish`](#event-publish) instead.

[CONNECT]: https://github.com/mqttjs/mqtt-packet#connect
[CONNACK]: https://github.com/mqttjs/mqtt-packet#connack
[SUBSCRIBE]: https://github.com/mqttjs/mqtt-packet#subscribe
[PINGREQ]: https://github.com/mqttjs/mqtt-packet#pingreq
[PUBLISH]: https://github.com/mqttjs/mqtt-packet#publish
[PUBREL]: https://github.com/mqttjs/mqtt-packet#pubrel
