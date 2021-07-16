'use strict'

const write = require('../write')
const { validateTopic, $SYS_PREFIX } = require('../utils')

function UnSubAck (packet) {
  this.cmd = 'unsuback'
  this.messageId = packet.messageId // [MQTT-3.10.4-4]
}

function UnsubscribeState (client, packet, finish) {
  this.client = client
  this.packet = packet
  this.finish = finish
}

function handleUnsubscribe (client, packet, done) {
  const broker = client.broker
  const unsubscriptions = packet.unsubscriptions
  let err

  for (let i = 0; i < unsubscriptions.length; i++) {
    err = validateTopic(unsubscriptions[i], 'UNSUBSCRIBE')
    if (err) {
      return done(err)
    }
  }

  if (packet.messageId !== undefined) {
    if (client.clean) {
      return actualUnsubscribe(client, packet, done)
    }

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
  const broker = client.broker
  broker._parallel(
    new UnsubscribeState(client, packet, done),
    doUnsubscribe,
    packet.unsubscriptions,
    completeUnsubscribe)
}

function doUnsubscribe (sub, done) {
  const client = this.client
  const broker = client.broker
  const s = client.subscriptions[sub]

  if (s) {
    const func = s.func
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
  const client = this.client

  if (err) {
    client.emit('error', err)
    return
  }

  const packet = this.packet
  const done = this.finish

  if (packet.messageId !== undefined) {
    write(client, new UnSubAck(packet),
      done)
  } else {
    done()
  }

  if ((!client.closed || client.clean === true) && packet.unsubscriptions.length > 0) {
    client.broker.emit('unsubscribe', packet.unsubscriptions, client)
    client.broker.publish({
      topic: $SYS_PREFIX + client.broker.id + '/new/unsubscribes',
      payload: Buffer.from(JSON.stringify({
        clientId: client.id,
        subs: packet.unsubscriptions
      }), 'utf8')
    }, noop)
  }
}

function noop () { }

module.exports = handleUnsubscribe
