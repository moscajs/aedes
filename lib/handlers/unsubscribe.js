import write from '../write.js'
import { validateTopic, $SYS_PREFIX, runParallel, once } from '../utils.js'

class UnSubAck {
  constructor (packet) {
    this.cmd = 'unsuback'
    this.messageId = packet.messageId // [MQTT-3.10.4-4]
  }
}

class UnsubscribeState {
  constructor (client, packet, finish) {
    this.client = client
    this.packet = packet
    this.finish = finish
  }
}

function handleUnsubscribe (client, packet, finish) {
  const done = once(finish)
  const broker = client.broker
  const unsubscriptions = packet.unsubscriptions
  let err

  for (let i = 0; i < unsubscriptions.length; i++) {
    err = validateTopic(unsubscriptions[i], 'UNSUBSCRIBE', broker.maxTopicLevels)
    if (err) {
      return done(err)
    }
  }

  if (packet.messageId !== undefined) {
    if (client.clean) {
      return actualUnsubscribe(client, packet, done)
    }

    broker.persistence.removeSubscriptions(client, unsubscriptions)
      .then(() => actualUnsubscribe(client, packet, done), done)
  } else {
    actualUnsubscribe(client, packet, done)
  }
}

function actualUnsubscribe (client, packet, done) {
  const state = new UnsubscribeState(client, packet, done)
  // Use the callback-based runParallel instead of Promise.all(unsubscriptions.map(...))
  // — see subscribe.js: avoids allocating a promise per topic on the control path.
  runParallel(state, doUnsubscribe, packet.unsubscriptions, (err) => {
    completeUnsubscribe.call(state, err)
  })
}

function doUnsubscribe (sub, done) {
  const client = this.client
  const broker = client.broker
  const s = client.subscriptions[sub]

  if (s) {
    const func = s.func
    broker.unsubscribe(
      sub,
      func,
      (err) => {
        if (err) {
          done(err)
        } else {
          delete client.subscriptions[sub]
          done()
        }
      })
  } else {
    done()
  }
}

function completeUnsubscribe (err) {
  const client = this.client
  const done = this.finish

  if (err) {
    client.emit('error', err)
    return done(err)
  }

  const packet = this.packet

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

export default handleUnsubscribe
