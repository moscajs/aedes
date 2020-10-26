<!-- markdownlint-disable MD013 MD024 -->
# Examples

## Simple plain MQTT server

```js
const aedes = require('aedes')()
const server = require('net').createServer(aedes.handle)
const port = 1883

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## Simple plain MQTT server using server-factory

```js
const aedes = require('aedes')()
const { createServer } = require('aedes-server-factory')
const port = 1883

const server = createServer(aedes)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## MQTT over TLS / MQTTS

```js
const fs = require('fs')
const aedes = require('aedes')()
const port = 8883

const options = {
  key: fs.readFileSync('YOUR_PRIVATE_KEY_FILE.pem'),
  cert: fs.readFileSync('YOUR_PUBLIC_CERT_FILE.pem')
}

const server = require('tls').createServer(options, aedes.handle)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## MQTT server over WebSocket

```js
const aedes = require('aedes')()
const httpServer = require('http').createServer()
const ws = require('websocket-stream')
const port = 8888

ws.createServer({ server: httpServer }, aedes.handle)

httpServer.listen(port, function () {
  console.log('websocket server listening on port ', port)
})
```

## MQTT server over WebSocket using server-factory

```js
const aedes = require('aedes')()
const { createServer } = require('aedes-server-factory')
const port = 8888

const httpServer = createServer(aedes, { ws: true })

httpServer.listen(port, function () {
  console.log('websocket server listening on port ', port)
})
```

## Clusters

In order to use Aedes in clusters you have to choose a persistence and an mqemitter that supports clusters. Tested persistence/mqemitters that works with clusters are:

- [mqemitter-redis]
- [mqemitter-child-process]
- [mqemitter-mongodb]
- [aedes-persistence-mongodb]
- [aedes-persistence-redis]

[This](https://github.com/moscajs/aedes/blob/master/examples/clusters/index.js) is an example using [mqemitter-mongodb] and [aedes-persistence-mongodb]

[aedes-persistence-mongodb]: https://www.npmjs.com/aedes-persistence-mongodb
[aedes-persistence-redis]: https://www.npmjs.com/aedes-persistence-redis

[mqemitter-redis]: https://www.npmjs.com/mqemitter-redis
[mqemitter-mongodb]: https://www.npmjs.com/mqemitter-mongodb
[mqemitter-child-process]: https://www.npmjs.com/mqemitter-child-process
