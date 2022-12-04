// example taken from https://github.com/moscajs/aedes/issues/187

// Server
const PORT = 1883
const TOPIC = 'main'

var aedes = require('aedes')()
var server = require('net').createServer(aedes.handle)

// helper function to log date+text to console:
const log = (text) => {
  console.log(`[${new Date().toLocaleString()}] ${text}`)
}

// client connection event:
aedes.on(
  'client',
  (client) => {
    let message = `Client ${client.id} just connected`
    log(message)
    aedes.publish({
      cmd: 'publish',
      qos: 2,
      topic: TOPIC,
      payload: message,
      retain: false
    })
  }
)

//client disconnection event:
aedes.on(
  'clientDisconnect',
  (client) => {
    message = `Client ${client.id} just DISconnected`
    log(message)
    aedes.publish({
      cmd: 'publish',
      qos: 2,
      topic: 'main',
      payload: message,
      retain: false
    })
  }
)

server.listen(PORT, function () {
  console.log(`server listening on port ${PORT}`)
})
