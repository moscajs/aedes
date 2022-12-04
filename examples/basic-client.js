// example taken from https://github.com/moscajs/aedes/issues/187#issuecomment-511886920

// Client
const SERVER = 'mqtt://localhost'
const TOPIC = 'main'

let mqtt = require('mqtt')
let client = mqtt.connect(SERVER)

// helper function to log date+text to console:
const log = (text) => {
  console.log(`[${new Date().toLocaleString()}] ${text}`)
}

// on connection event:
client.on(
  'connect',
  (message) => {
    log(`Connected to ${SERVER}`)
    client.subscribe('main')
    client.publish('main', 'Hi there!')
  }
)

// on message received event:
client.on(
  'message',
  (topic, message) => {
    log(`Message received on topic ${topic}: ${message.toString()}`)
  }
)
