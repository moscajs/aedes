<!-- markdownlint-disable MD013 MD024 -->
# Client

- [Client](#client)
  - [new Client(aedes, stream, request)](#new-clientaedes-stream-request)
  - [client.conn](#clientconn)
  - [client.req](#clientreq)
  - [client.connecting](#clientconnecting)
  - [client.connected](#clientconnected)
  - [client.closed](#clientclosed)
  - [client.id](#clientid)
  - [client.clean](#clientclean)
  - [client.version](#clientversion)
  - [Event: connected](#event-connected)
  - [Event: error](#event-error)
  - [client.publish (packet, [callback])](#clientpublish-packet-callback)
  - [client.subscribe (subscriptions, [callback])](#clientsubscribe-subscriptions-callback)
  - [client.unsubscribe (unsubscriptions, [callback])](#clientunsubscribe-unsubscriptions-callback)
  - [client.close ([callback])](#clientclose-callback)
  - [client.emptyOutgoingQueue ([callback])](#clientemptyoutgoingqueue-callback)

## new Client(aedes, stream, request)

- aedes [`<Aedes>`](./Aedes.md)
- stream: `<net.Socket>` | `<stream.Duplex>`
- request: `<http.IncomingMessage>`
- Returns: `<Client>`

## client.conn

- `<net.Socket>` | `<stream.Duplex>`

Client connection stream object.

In the case of `net.createServer`, `conn` passed to the `connectionlistener` function by node's [net.createServer](https://nodejs.org/api/net.html#net_net_createserver_options_connectionlistener) API.

In the case of [`websocket-stream`][websocket-stream], it's the `stream` argument passed to the websocket `handle` function in [`websocket-stream #on-the-server`][websocket-stream-doc-on-the-server]].

## client.req

- `<http.IncomingMessage>`

only for [`websocket-stream`][websocket-stream]. It is a HTTP Websocket upgrade request object passed to websocket `handle` function in [`websocket-stream #on-the-server`][websocket-stream-doc-on-the-server]. It gives an option for accessing headers or cookies.

## client.connecting

- `<boolean>` __Default__: `false`

a read-only flag, it is true when Client is in CONNECT phase. Aedes emits `connackSent` event will not reset `connecting` to `false` until it received all its offline messagess to the Client.

## client.connected

- `<boolean>` __Default__: `false`

a read-only flag, it is `true` when `connected` event is emitted, and `false` when client is closed.

## client.closed

- `<boolean>` __Default__: `false`

a read-only flag indicates if client is closed or not.

## client.id

- `<string>` __Default__: `aedes_${hyperid()}`

Client unique identifier, specified by CONNECT packet.

It is available only after `CONNACK (rc=0)`, otherwise it is `null` in cases:

- in [`aedes.preConnect`](./Aedes.md#handler-preconnect-client-callback) stage
- after `CONNACK (rc!=0)` response
- `connectionError` raised by aedes

## client.clean

- `<boolean>` __Default__: `true`

Client clean flag, set by clean flag in `CONNECT` packet.

## client.version

- `<number>` __Default__: `null`

Client version, set by protocol version in `CONNECT` packet when `CONNACK (rc=0)` returns.

## Event: connected

Same as aedes [`clientReady`](./Aedes.md#event-clientready) but in client-wise.

## Event: error

- `error` `<Error>`

Emitted when an error occurs.

## client.publish (packet, [callback])

- `packet` `<object>` [`PUBLISH`][PUBLISH]
- `callback` `<Function>` `(error) => void`
  - error `<Error>` | `null`

Publish the given `packet` to this client. QoS 1 and 2 are fully supported, while the retained flag is not.

`callback`  will be invoked when the message has been sent, but not acked.

## client.subscribe (subscriptions, [callback])

- `subscriptions` `<object>`
- `callback` `<Function>` `(error) => void`
  - error `<Error>` | `null`

Subscribe client to the list of topics.

`subscriptions` can be:

1. a single object in the format `{ topic: topic, qos: qos }`
2. an array of the above
3. a full [`SUBSCRIBE`][SUBSCRIBE], specifying a `messageId` will send suback to the client.

`callback`  will be invoked when the subscription is completed.

## client.unsubscribe (unsubscriptions, [callback])

- `unsubscriptions` `<object>`
- `callback` `<Function>` `(error) => void`
  - error `<Error>` | `null`

Unsubscribe client to the list of topics.

`unsubscriptions` can be:

1. a single object in the format `{ topic: topic, qos: qos }`
2. an array of the above
3. a full [`UNSUBSCRIBE`][UNSUBSCRIBE]

`callback`  will be invoked when the unsubscriptions are completed.

## client.close ([callback])

Disconnect client

`callback` will be invoked when client is closed.

## client.emptyOutgoingQueue ([callback])

Clear all outgoing messages (QoS > 1) related to this client from persistence

`callback` will be invoked when the operation ends.

[PUBLISH]: https://github.com/mqttjs/mqtt-packet#publish
[SUBSCRIBE]: https://github.com/mqttjs/mqtt-packet#subscribe
[UNSUBSCRIBE]: https://github.com/mqttjs/mqtt-packet#unsubscribe

[websocket-stream]: https://www.npmjs.com/websocket-stream
[websocket-stream-doc-on-the-server]: https://github.com/maxogden/websocket-stream/blob/master/readme.md#on-the-server
