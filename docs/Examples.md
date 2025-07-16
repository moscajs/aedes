<!-- markdownlint-disable MD013 MD024 -->
# Examples

## Simple plain MQTT server

```js
import { createServer } from 'node:net'
import Aedes from 'aedes'

const port = 1883

const aedes = await Aedes.createBroker()
const server = createServer(aedes.handle)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## CommonJS

```js
const { createServer } = require('node:net')
const { Aedes } = require('aedes')

const aedes = await Aedes.createBroker()
const port = 1883
const server = createServer(aedes.handle)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## Simple plain MQTT server using server-factory

```js
import { Aedes } from 'aedes'
import { createServer } from 'aedes-server-factory'
const port = 1883

const aedes = await Aedes.createBroker()
const server = createServer(aedes)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## MQTT over TLS / MQTTS

```js
import { createServer } from 'node:tls'
import { readFileSync } from 'node:fs'
import { Aedes } from 'aedes'

const port = 8883

const options = {
  key: readFileSync('YOUR_PRIVATE_KEY_FILE.pem'),
  cert: readFileSync('YOUR_PUBLIC_CERT_FILE.pem')
}
const aedes = await Aedes.createBroker()
const server = createServer(options, aedes.handle)

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

## MQTT server over WebSocket

```js
import { createServer } from 'node:http'
import { Aedes } from 'aedes'
import { WebSocketServer, createWebSocketStream } from 'ws'

const port = 8888

const aedes = await Aedes.createBroker()
const httpServer = createServer()
const wss = new WebSocketServer({
  server:httpServer
})

wss.on('connection', (websocket, req) => {
  const stream = createWebSocketStream(websocket)
  aedes.handle(stream, req)
})

httpServer.listen(port, function () {
  console.log('websocket server listening on port ', port)
})
```

## MQTT server over WebSocket using server-factory

```js
import { Aedes } from 'aedes'
import { createServer } from 'aedes-server-factory'
const port = 8888

const aedes = await Aedes.createBroker()
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
