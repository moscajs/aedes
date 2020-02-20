'use-strict'

module.exports = Group

function SharedSubscription (group, topic) {
  this.clients = []
  this.group = group
  this.topic = topic
  this.subscriptions = {} // clientid: qos
  this._next = 0
  this.isShared = true
}

function Group (id, broker) {
  this.id = id
  this.broker = broker
  this.subscriptions = {} // topic: SharedSubscription

  broker.groups[id] = this
}

Group.prototype.subscribe = function (client, qos, topic, done) {
  var shared = this.subscriptions[topic] || new SharedSubscription(this, topic)
  var clientSubQoS = shared.subscriptions[client.id]

  if (clientSubQoS === undefined) {
    shared.subscriptions[client.id] = qos
    client.subscriptions[topic] = shared
    this.broker.subscribe(topic, this.deliverMessage, done)
  } else if (clientSubQoS !== qos) {
    shared.subscriptions[client.id] = qos
  } else {
    done()
  }
}

Group.prototype.unsubscribe = function (shared, client, done) {
  delete shared.subscriptions[client.id]
  var index = shared.clients.indexOf(client)

  if (index < shared._next && shared._next > 0) shared._next--

  shared.clients.splice(index, 1)
  this.broker.unsubscribe(shared.topic, this.deliverMessage, done)
}

Group.prototype.deliverMessage = function (_packet, cb) {
  var shared = this.subscriptions[_packet.topic]

  if (shared._next === shared.clients.length) shared._next = 0
  var client = shared.clients[shared._next++]

  if (client) client.deliverQoS(_packet, cb)
}
