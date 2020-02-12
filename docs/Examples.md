<!-- markdownlint-disable MD013 MD024 -->
# Examples

Simple plain MQTT server

```js
const aedes = require('aedes')()
const server = require('net').createServer(aedes.handle)
const port = 1883

server.listen(port, function () {
  console.log('server started and listening on port ', port)
})
```

MQTT over TLS / MQTTS

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

MQTT server over WebSocket

```js
const aedes = require('./aedes')()
const httpServer = require('http').createServer()
const ws = require('websocket-stream')
const port = 8888

ws.createServer({ server: httpServer }, aedes.handle)

httpServer.listen(port, function () {
  console.log('websocket server listening on port ', port)
})
```
