'use strict'

const aedes = require('./aedes')()
const server = require('net').createServer(aedes.handle)
const httpServer = require('http').createServer()
const ws = require('ws')
const port = 1883
const wsPort = 8888

server.listen(port, function () {
  console.log('server listening on port', port)
})

const wss = new ws.WebSocketServer({
  server
})

wss.on('connection', (websocket, req) => {
  const stream = ws.createWebSocketStream(websocket)
  aedes.handle(stream, req)
})

httpServer.listen(wsPort, function () {
  console.log('websocket server listening on port', wsPort)
})

aedes.on('clientError', function (client, err) {
  console.log('client error', client.id, err.message, err.stack)
})

aedes.on('connectionError', function (client, err) {
  console.log('client error', client, err.message, err.stack)
})

aedes.on('publish', function (packet, client) {
  if (client) {
    console.log('message from client', client.id)
  }
})

aedes.on('subscribe', function (subscriptions, client) {
  if (client) {
    console.log('subscribe from client', subscriptions, client.id)
  }
})

aedes.on('client', function (client) {
  console.log('new client', client.id)
})
