'use-strict'

module.exports = Group

function SharedSubscription () {
  this.clients = []
  this.subscriptions = {} // clientid: qos
  this._next = 0
}

function Group (id, broker) {
  this.id = id
  this.broker = broker
  this.subscriptions = {}

  broker.groups[id] = this
}

Group.prototype.subscribe = function (client, qos, topic, done) {
  var shared = this.subscriptions[topic] || new SharedSubscription()
  var clientSubQoS = shared.subscriptions[client.id]

  if (clientSubQoS === undefined) {
    shared.subscriptions[client.id] = qos
    this.broker.subscribe(topic, this.deliverMessage, done)
  } else if (clientSubQoS !== qos) {
    shared.subscriptions[client.id] = qos
  } else {
    done()
  }
}

Group.prototype.unsubscribe = function (client, sub, topic, done) {
  var index = this.clients.indexOf(client)
  if (index >= 0) {
    this.clients.splice(index, 1)
  } else {
    this.broker.emit('error', new Error('Unable to remove client ' + client.id + 'from group ' + this.id))
  }
}

Group.prototype.deliverMessage = function (_packet, cb) {
  var shared = this.subscriptions[_packet.topic]

  if (shared._next === shared.clients.length) shared._next = 0
  var client = shared.clients[shared._next++]

  client.deliverQoS(_packet, cb)
}
