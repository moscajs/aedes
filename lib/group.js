'use-strict'

module.exports = Group

function Group (id, broker) {
  this.id = id
  this.clients = []
  this.broker = broker
  this.subscriptions = {}

  broker.groups[id] = this

  this._next = 0
}

Group.prototype.add = function (client) {
  this.clients.push(client)
}

Group.prototype.remove = function (client) {
  var index = this.clients.indexOf(client)
  if (index >= 0) {
    this.clients.splice(index, 1)
  } else {
    this.broker.emit('error', new Error('Unable to remove client ' + client.id + 'from group ' + this.id))
  }
}

Group.prototype.deliverMessage = function (_packet, cb) {
  if (this._next === this.clients.length) this._next = 0
  var client = this.clients[this._next++]

  client.deliverQoS(_packet, cb)
}
