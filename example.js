
var aedes   = require('./aedes')()
  , server  = require('net').createServer(aedes.handle)
  , port    = 1883

server.listen(port, function() {
  console.log('server listening on port', port)
})
