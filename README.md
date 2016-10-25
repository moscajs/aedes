# Aedes&nbsp;&nbsp;[![Build Status](https://travis-ci.org/mcollina/aedes.svg)](https://travis-ci.org/mcollina/aedes)&nbsp;[![Coverage Status](https://coveralls.io/repos/mcollina/aedes/badge.svg?branch=master&service=github)](https://coveralls.io/github/mcollina/aedes?branch=master)

Barebone MQTT server that can run on any stream server.

[![js-standard-style](https://cdn.rawgit.com/feross/standard/master/badge.svg)](https://github.com/feross/standard)

* [Install](#install)
* [Example](#example)
* [API](#api)
* [TODO](#todo)
* [Acknowledgements](#acknowledgements)
* [License](#license)


<a name="install"></a>
## Install
To install aedes, simply use npm:

```
npm install aedes --save
```

<a name="example"></a>
## Example
```js
var aedes = require('aedes')()
var server = require('net').createServer(aedes.handle)
var port = 1883

server.listen(port, function () {
  console.log('server listening on port', port)
})
```

<a name="api"></a>
## API

  * <a href="#constructor"><code><b>aedes()</b></code></a>
  * <a href="#handle"><code>instance.<b>handle()</b></code></a>
  * <a href="#subscribe"><code>instance.<b>subscribe()</b></code></a>
  * <a href="#publish"><code>instance.<b>publish()</b></code></a>
  * <a href="#unsubscribe"><code>instance.<b>unsubscribe()</b></code></a>
  * <a href="#authenticate"><code>instance.<b>authenticate()</b></code></a>
  * <a href="#authorizePublish"><code>instance.<b>authorizePublish()</b></code></a>
  * <a href="#authorizeSubscribe"><code>instance.<b>authorizeSubscribe()</b></code></a>
  * <a href="#authorizeForward"><code>instance.<b>authorizeForward()</b></code></a>
  * <a href="#published"><code>instance.<b>published()</b></code></a>
  * <a href="#close"><code>instance.<b>close()</b></code></a>
  * <a href="#client"><code><b>Client</b></code></a>
  * <a href="#clientid"><code>client.<b>id</b></code></a>
  * <a href="#clientclean"><code>client.<b>clean</b></code></a>
  * <a href="#clientpublish"><code>client.<b>publish()</b></code></a>
  * <a href="#clientsubscribe"><code>client.<b>subscribe()</b></code></a>
  * <a href="#clientClose"><code>client.<b>close()</b></code></a>

-------------------------------------------------------
<a name="constructor"></a>
### aedes([opts])

Creates a new instance of Aedes.

Options:

* `mq`: an instance of [MQEmitter](http://npm.im/mqemitter),
  such as [MQEmitterRedis](http://npm.im/mqemitter-redis)
  or [MQEmitterMongoDB](http://npm.im/mqemitter-mongodb)
* `persistence`: an instance of [AedesPersistence](http://npm.im/aedes-persistence),
  such as [aedes-persistence-redis](http://npm.im/aedes-persistence-redis)
  or [aedes-persistence-mongodb](http://npm.im/aedes-persistence-mongodb)
* `concurrency`: the max number of messages delivered concurrently,
  defaults to `100`.
* `heartbeatInterval`: the interval at which the broker heartbeat is
  emitted, it used by other broker in the cluster, the default is
  `60000` milliseconds.
* `connectTimeout`: the max number of milliseconds to wait for the CONNECT
  packet to arrive, defaults to `30000` milliseconds.
* `authenticate`: function used to authenticate clients, see
  [instance.authenticate()](#authenticate).
* `authorizePublish`: function used to authorize PUBLISH packets, see
  [instance.authorizePublish()](#authorizePublish).
* `authorizeSubscribe`: function used to authorize SUBSCRIBE packets, see
  [instance.authorizeSubscribe()](#authorizeSubscribe).
* `authorizeForward`: function used to authorize forwarded packets, see
  [instance.authorizeForward()](#authorizeForward).
* `published`: function called when a new packet is published, see
  [instance.published()](#published).

Events:

* `client`: when a new [Client](#client) connects, arguments:
  1. `client`
* `clientDisconnect`: when a [Client](#client) disconnects, arguments:
  1. `client`
* `clientError`: when a [Client](#client) errors, arguments:
  1. `client`
  2. `err`
* `keepaliveTimeout`: when a [Client](#client) keepalive times out, arguments:
  1. `client`
* `publish`: when a new packet is published, arguments:
  1. `packet`
  2. `client`, it will be null if the message is published using
     [`publish`](#publish).
* `ack`: when a packet published to a client is delivered successfully with QoS 1 or QoS 2, arguments:
  1. `packet`
  2. `client`
* `ping`: when a [Client](#client) sends a ping, arguments:
  1. `packet`
  2. `client`
* `subscribe`: when a client sends a SUBSCRIBE, arguments:
  1. `subscriptions`, as defined in the `subscriptions` property of the
     [SUBSCRIBE](https://github.com/mqttjs/mqtt-packet#subscribe)
packet.
  2. `client`
* `unsubscribe`: when a client sends a UNSUBSCRIBE, arguments:
  1. `unsubscriptions`, as defined in the `subscriptions` property of the
     [UNSUBSCRIBE](https://github.com/mqttjs/mqtt-packet#unsubscribe)
packet.
  2. `client`
* `connackSent`: when a CONNACK packet is sent to a client [Client](#client) (happens after `'client'`), arguments:
  1. `client`

-------------------------------------------------------
<a name="handle"></a>
### instance.handle(duplex)

Handle the given duplex as a MQTT connection.

```js
var aedes = require('./aedes')()
var server = require('net').createServer(aedes.handle)
```

-------------------------------------------------------
<a name="subscribe"></a>
### instance.subscribe(topic, func(packet, cb), done)

After `done` is called, every time [publish](#publish) is invoked on the
instance (and on any other connected instances) with a matching `topic` the `func` function will be called.

`func` needs to call `cb` after receiving the message.

It supports backpressure.

-------------------------------------------------------
<a name="publish"></a>
### instance.publish(packet, done)

Publish the given packet to subscribed clients and functions. It supports backpressure.

A packet must contain the following properties:

```js
{
  cmd: 'publish',
  qos: 2,
  topic: 'test',
  payload: new Buffer('test'),
  retain: false
}
```

Only the `topic` and properties are mandatory
Both `topic` and `payload` can be `Buffer` objects instead of strings.

-------------------------------------------------------
<a name="unsubscribe"></a>
### instance.unsubscribe(topic, func(packet, cb), done)

The reverse of [subscribe](#subscribe).

-------------------------------------------------------
<a name="authenticate"></a>
### instance.authenticate(client, username, password, done(err, successful))

It will be called when a new client connects. Ovverride to supply custom
authentication logic.

```js
instance.authenticate = function (client, username, password, callback) {
  callback(null, username === 'matteo')
}
```
Other return codes can passed as follows :-

```js
instance.authenticate = function (client, username, password, callback) {
  var error = new Error('Auth error')
  error.returnCode = 1
  callback(error, null)
}
```
The return code values and their responses which can be passed are given below :-

*  `1` - Unacceptable protocol version
*  `2` - Identifier rejected
*  `3` - Server unavailable
*  `4` - Bad user name or password

-------------------------------------------------------
<a name="authorizePublish"></a>
### instance.authorizePublish(client, packet, done(err))

It will be called when a client publishes a message. Override to supply custom
authorization logic.

```js
instance.authorizePublish = function (client, packet, callback) {
  if (packet.topic === 'aaaa') {
    return callback(new Error('wrong topic'))
  }

  if (packet.topic === 'bbb') {
    packet.payload = new Buffer('overwrite packet payload')
  }

  callback(null)
}
```

-------------------------------------------------------
<a name="authorizeSubscribe"></a>
### instance.authorizeSubscribe(client, pattern, done(err, pattern))

It will be called when a client publishes a message. Override to supply custom
authorization logic.

```js
instance.authorizeSubscribe = function (client, sub, cb) {
  if (sub.topic === 'aaaa') {
    return cb(new Error('wrong topic'))
  }

  if (sub.topic === 'bbb') {
    // overwrites subscription
    sub.qos = sub.qos + 2
  }

  callback(null, sub)
}
```

To negate a subscription, set the subscription to `null`:

```js
instance.authorizeSubscribe = function (client, sub, cb) {
  if (sub.topic === 'aaaa') {
    sub = null
  }

  callback(null, sub)
}
```

-------------------------------------------------------
<a name="authorizeForward"></a>
### instance.authorizeForward(clientId, packet)

It will be called when a client is set to recieve a message. Override to supply custom
authorization logic.
In order to completely pre

```js
instance.authorizeForward = function (clientId, packet) {
  if (packet.topic === 'aaaa' && clientId === "I should not see this") {
    return null
    // also works with return undefined
  }

  if (packet.topic === 'bbb') {
    packet.payload = new Buffer('overwrite packet payload')
  }

  return packet
}
```

-------------------------------------------------------
<a name="published"></a>
### instance.published(packet, client, done())

It will be after a message is published.
`client` will be null for internal messages.
Ovverride to supply custom authorization logic.

-------------------------------------------------------
<a name="close"></a>
### instance.close([cb])

Disconnects all clients.

-------------------------------------------------------
<a name="Client"></a>
### Client

Classes for all connected clients.

Events:

* `error`, in case something bad happended

-------------------------------------------------------
<a name="clientid"></a>
### client#id

The id of the client, as specified by the CONNECT packet.

-------------------------------------------------------
<a name="clientclean"></a>
### client#client

`true` if the client connected (CONNECT) with `clean: true`, `false`
otherwise. Check the MQTT spec for what this means.

-------------------------------------------------------
<a name="clientpublish"></a>
### client#publish(message, [callback])

Publish the given `message` to this client. QoS 1 and 2 are fully
respected, while the retained flag is not.

`message` is a [PUBLISH](https://github.com/mqttjs/mqtt-packet#publish) packet.

`callback`  will be called when the message has been sent, but not acked.

-------------------------------------------------------
<a name="clientsubscribe"></a>
### client#subscribe(subscriptions, [callback])

Subscribe the client to the list of topics.

`subscription` can be:

1. a single object in the format `{ topic: topic, qos: qos }`
2. an array of the above
3. a full [subscribe
   packet](https://github.com/mqttjs/mqtt-packet#subscribe),
specifying a `messageId` will send suback to the client.

`callback`  will be called when the subscription is completed.

-------------------------------------------------------
<a name="clientclose"></a>
### client#close([cb])

Disconnects the client

-------------------------------------------------------
<a name="clientpresence"></a>
### client presence

You can subscribe on the following $SYS topics to get client presence

 - `$SYS/+/new/clients` - Will inform about new clients connections
 - `$SYS/+/disconnect/clients` - Will inform about client disconnections
The payload will contain the clientId of the connected/disconnected client


<a name="todo"></a>
## Todo

* [x] QoS 0 support
* [x] Retain messages support
* [x] QoS 1 support
* [x] QoS 2 support
* [x] clean=false support
* [x] Keep alive support
* [x] Will messages must survive crash
* [x] Authentication
* [x] Events
* [x] Wait a CONNECT packet only for X seconds
* [x] Support a CONNECT packet without a clientId
* [x] Disconnect other clients with the same client.id
* [x] Write docs
* [x] Support counting the number of offline clients and subscriptions
* [x] Performance optimizations for QoS 1 and Qos 2
* [x] Add `client#publish()` and `client#subscribe()`
* [x] move the persistence in a separate module
* [x] mongo persistence ([external module](http://npm.im/aedes-persistence-mongodb))
* [x] redis persistence ([external module](http://npm.im/aedes-persistence-redis))
* [x] leveldb persistence ([external module](http://npm.im/aedes-persistence-level))
* [ ] cluster support (external module)

## Acknowledgements

This library is born after a lot of discussion with all
[Mosca](http://npm.im/mosca) users, and how that was deployed in
production. This addresses your concerns about performance and
stability.

## License

MIT
