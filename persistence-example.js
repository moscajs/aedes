"use strict";

var persistence = require("aedes-persistence");
var aedes = require("./aedes")({
  persistence: persistence()
});

var server = require("net").createServer(aedes.handle);
var httpServer = require("http").createServer();
var ws = require("websocket-stream");
var port = 1883;
var wsPort = 8888;

aedes.authorizeSubscribe = function(client, sub, cb) {
  if (sub.topic === "hello/5") {
    return cb(null, sub);
  } else {
    cb(null, null);
  }
};

server.listen(port, function() {
  console.log("server listening on port", port);
});

ws.createServer(
  {
    server: httpServer
  },
  aedes.handle
);

httpServer.listen(wsPort, function() {
  console.log("websocket server listening on port", wsPort);
});

aedes.on("clientError", function(client, err) {
  console.log("client error", client.id, err.message, err.stack);
});

aedes.on("connectionError", function(client, err) {
  console.log("client error", client, err.message, err.stack);
});

aedes.on("publish", function(packet, client) {
  if (client) {
    console.log("message from client", client.id);
  }
});

aedes.on("subscribe", function(subscriptions, client) {
  if (client) {
    console.log("subscribe from client", subscriptions, client.id);
  }
});

aedes.on("client", function(client) {
  console.log("new client", client.id);
});
