'use strict'

var write = require('../write')
var validateTopic = require('./validations').validateTopic

function UnsubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.granted = granted
}

function handleUnsubscribe (client, packet, done) {
  var broker = client.broker
  var unsubscriptions = packet.unsubscriptions
  var err

  for (var i = 0; i < unsubscriptions.length; i++) {
    err = validateTopic(unsubscriptions[i], 'UNSUBSCRIBE')
    if (err) {
      return done(err)
    }
  }

  if (packet.messageId) {
    broker.persistence.removeSubscriptions(client, unsubscriptions, function (err) {
      if (err) {
        return done(err)
      }

      actualUnsubscribe(client, packet, done)
    })
  } else {
    actualUnsubscribe(client, packet, done)
  }
}

function actualUnsubscribe (client, packet, done) {
  var broker = client.broker
  broker._series(
    new UnsubscribeState(client, packet, done, null),
    doUnsubscribe,
    packet.unsubscriptions,
    completeUnsubscribe)
}

function doUnsubscribe (sub, done) {
  var client = this.client
  var broker = client.broker
  if (client.subscriptions[sub]) {
    var func = client.subscriptions[sub].func
    delete client.subscriptions[sub]
    broker.unsubscribe(
      sub,
      func,
      done)
  } else {
    done()
  }
}

function completeUnsubscribe (err) {
  var packet = this.packet
  var client = this.client
  var done = this.finish

  if (err) {
    return client.emit('error', err)
  }

  if (client.clean === true && packet.unsubscriptions.length > 0) {
    client.broker.emit('unsubscribe', packet.unsubscriptions, client)
  }

  if (packet.messageId) {
    var response = {
      cmd: 'unsuback',
      messageId: packet.messageId
    }

    write(client, response, done)
  } else {
    done()
  }
}

module.exports = handleUnsubscribe
