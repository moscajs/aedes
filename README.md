# Aedes&nbsp;&nbsp;[![Build Status](https://travis-ci.org/mcollina/aedes.png)](https://travis-ci.org/mcollina/aedes)

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
var aedes = require('./aedes')()
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
  * <a href="#close"><code>instance.<b>close()</b></code></a>
  * <a href="#client"><code><b>Client</b></code></a>
  * <a href="#clientClose"><code>client.<b>close()</b></code></a>

-------------------------------------------------------
<a name="constructor"></a>
### aedes([opts])

Creates a new instance of Aedes.

Options:

* `mq`: an instance of [MQEmitter](http://npm.im/mqemitter).
* `concurrency`: the max number of messages delivered concurrently,
  defaults to `100`.
* `heartbeatInterval`: the interval at which the broker heartbeat is
  emitted, it used by other broker in the cluster, the default is
  `60000` milliseconds.
* `connectTimeout`: the max number of milliseconds to wait for the CONNECT
  packet to arrive, defaults to `30000` milliseconds.

Events:

* `client`: when a new [Client](#client) connects
* `clientError`: when a [Client](#client) errors

-------------------------------------------------------
<a name="handle"></a>
### handle(duplex)

Handle the given duplex as a MQTT connection.

```js
var aedes = require('./aedes')()
var server = require('net').createServer(aedes.handle)
```

-------------------------------------------------------
<a name="subscribe"></a>
### subscribe(topic, func(packet, cb), done)

After `done` is called, every time [publish](#publish) is invoked on the
instance (and on any other connected instances) with a matching `topic` the `func` function will be called. It also support retained messages lookup.

`func` needs to call `cb` after receiving the message.

It supports backpressure.

-------------------------------------------------------
<a name="publish"></a>
### publish(packet, done)

Publish the given packet to subscribed clients and functions. A packet
must be valid for [mqtt-packet](http://npm.im/mqtt-packet).

It supports backpressure.

-------------------------------------------------------
<a name="unsubscribe"></a>
### unsubscribe(topic, func(packet, cb), done)

The reverse of [subscribe](#subscribe).

-------------------------------------------------------
<a name="authenticate"></a>
### authenticate(client, username, password, done(err, successful))

It will be called when a new client connects. Ovverride to supply custom
authentication logic.

```js
instance.authenticate = function (client, username, password, callback) {
  callback(null, username === 'matteo')
}
```

-------------------------------------------------------
<a name="authorizePublish"></a>
### authorizePublish(client, packet, done(err))

It will be called when a client publishes a message. Ovverride to supply custom
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
### authorizeSubscribe(client, pattern, done(err, pattern))

It will be called when a client publishes a message. Ovverride to supply custom
authorization logic.

```js
instance.authorizeSubscribe = function (client, sub, cb) {
  if (sub === 'aaaa') {
    return cb(new Error('wrong topic'))
  }

  if (sub === 'bbb') {
    // overwrites subscription
    sub = '42'
  }

  callback(null, sub)
}
```

-------------------------------------------------------
<a name="close"></a>
### close([cb])

Disconnects all clients.

-------------------------------------------------------
<a name="Client"></a>
### Client

Classes for all connected clients.

Events:

* `error`, in case something bad happends

-------------------------------------------------------
<a name="close"></a>
### client#close([cb])

Disconnects the client

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
* [ ] Mosca events
* [x] Wait a CONNECT packet only for X seconds
* [x] Support a CONNECT packet without a clientId
* [x] Disconnect other clients with the same client.id
* [x] Write docs
* [x] Support counting the number of offline clients and subscriptions
* [ ] Add `client#publish()` and `client#subscribe()`
* [ ] move the persistence in a separate module
* [ ] mongo persistence (external module)
* [ ] redis persistence (external module)
* [ ] levelup persistence (external module)

## Acknowledgements

This library is born after a lot of discussion with all
[Mosca](http://npm.im/mosca) users, and how that was deployed in
production. This addresses your concerns about performance and
stability.

## License

MIT
