# Aedes

Barebone MQTT server that can run on any stream server.

## Example

```js
var aedes   = require('./aedes')()
  , server  = require('net').createServer(aedes.handle)
  , port    = 1883

server.listen(port, function() {
  console.log('server listening on port', port)
})
```

## Todo

* [x] QoS 0 support
* [x] Retain messages support
* [ ] QoS 1 support
* [ ] QoS 2 support
* [ ] clean=false support
* [ ] mongo persistence (external module)
* [ ] redis persistence (external module)
* [ ] levelup persistence (external module)

## License

MIT
