# Aedes&nbsp;&nbsp;[![Build Status](https://travis-ci.org/mcollina/aedes.png)](https://travis-ci.org/mcollina/aedes)

Barebone MQTT server that can run on any stream server.

[![js-standard-style](https://cdn.rawgit.com/feross/standard/master/badge.svg)](https://github.com/feross/standard)

## Example

```js
var aedes = require('./aedes')()
var server = require('net').createServer(aedes.handle)
var port = 1883

server.listen(port, function () {
  console.log('server listening on port', port)
})
```

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
* [ ] Write docs
* [ ] Support counting the number of offline clients and subscriptions
* [ ] move the persistence in a separate module
* [ ] mongo persistence (external module)
* [ ] redis persistence (external module)
* [ ] levelup persistence (external module)

## License

MIT
