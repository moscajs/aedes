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

## Typescript

```ts
import Aedes from 'aedes'
import { createServer } from 'net'

const port = 1883

const aedes = new Aedes()
const server = createServer(aedes.handle)

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

## Client userdata

The tag `userdata` on the client structure is free for use by users to store whatever they want.

<details>
  <summary>Example snippet which uses JWT authentication, and captures the client ip address:</summary>
  
```
  broker.authenticate = (client, username, password, callback)=>{
    username = (username || '');
    password = (password || '').toString();
    let allow = false;
    client.userdata = {};
    if ((username === 'jwt')){
      try {
        var token = jwt.verify( password, secret );
        // store token away for future use
        client.userdata.token = token;
        allow = true;
      } catch(e) {
        console.log('invalid jwt');
      }
    }
    if (allow){
      if (client.conn && client.conn.remoteAddress){
        client.userdata.ip = client.conn.remoteAddress;
      }
      if (client.req){
        if (client.req.socket){
          client.userdata.ip = client.req.socket.remoteAddress;
        }
        if (client.req.rawHeaders){
          for (let i = 0; i < client.req.rawHeaders.length; i++){
            if (client.req.rawHeaders[i] === 'x-forwarded-for'){
              client.userdata.ip = client.req.rawHeaders[i+1];
            }
          }
        }
      }
    }
    callback(null, allow);
  }
```

</details>
