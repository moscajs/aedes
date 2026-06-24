import { runSeries } from '../utils.js'
import write from '../write.js'
import { ReasonCodes } from '../constants.js'

class PubAck {
  constructor (packet) {
    this.cmd = 'puback'
    this.messageId = packet.messageId
  }
}

class PubRec {
  constructor (packet) {
    this.cmd = 'pubrec'
    this.messageId = packet.messageId
  }
}

const publishActions = [
  authorizePublish,
  enqueuePublish
]
function handlePublish (client, packet, done) {
  // MQTT 5.0: resolve an inbound Topic Alias to its topic (and strip the
  // alias so it is not forwarded to subscribers) before topic validation.
  if (client.version === 5 && packet.properties?.topicAlias !== undefined) {
    const err = resolveTopicAlias(client, packet)
    if (err) {
      // Topic Alias protocol violation: surface the detail for telemetry, then
      // tell the client with a 0x94 (Topic Alias invalid) DISCONNECT — an
      // observable reason code on the wire rather than a bare connection drop.
      client.broker.emit('clientError', client, err)
      client.disconnect({ reasonCode: ReasonCodes.TOPIC_ALIAS_INVALID }, () => done())
      return
    }
  }
  const topic = packet.topic
  let err
  if (topic.length === 0) {
    err = new Error('empty topic not allowed in PUBLISH')
    return done(err)
  }
  if (topic.indexOf('#') > -1) {
    err = new Error('# is not allowed in PUBLISH')
    return done(err)
  }
  if (topic.indexOf('+') > -1) {
    err = new Error('+ is not allowed in PUBLISH')
    return done(err)
  }
  runSeries(client, publishActions, packet, done)
}

function enqueuePublish (packet, done) {
  const client = this

  // MQTT 5.0: an unauthorized QoS > 0 publish was already answered with a
  // 0x87 (Not authorized) PUBACK/PUBREC in authorizePublish; do not publish it.
  if (packet._notAuthorized) {
    return done()
  }

  switch (packet.qos) {
    case 2:
      // MQTT-4.3.3-2: Check if we already have this packet by messageId
      client.broker.persistence.incomingGetPacket(client, packet)
        .then(() => {
          // Duplicate packet: just send PUBREC, don't publish again
          write(client, new PubRec(packet), done)
        }, () => {
          // New packet (not found in store): store first, then publish
          // This ensures if storage fails, message hasn't been delivered yet
          // preventing duplicate delivery on retransmission
          client.broker.persistence.incomingStorePacket(client, packet)
            .then(() => {
              client.broker.publish(packet, client, (err) => {
                if (err) { return done(err) }
                write(client, new PubRec(packet), done)
              })
            }, done)
        })
      break
    case 1:
      write(client, new PubAck(packet), function (err) {
        if (err) { return done(err) }
        client.broker.publish(packet, client, done)
      })
      break
    case 0:
      client.broker.publish(packet, client, done)
      break
    default:
      // nothing to do
  }
}

function authorizePublish (packet, done) {
  const client = this
  client.broker.authorizePublish(client, packet, function (err) {
    if (!err) {
      return done()
    }
    // MQTT 5.0: rather than dropping the connection, answer an unauthorized
    // QoS > 0 publish with a 0x87 (Not authorized) acknowledgement and stop.
    if (client.version === 5 && packet.qos > 0) {
      packet._notAuthorized = true
      const ack = packet.qos === 1 ? new PubAck(packet) : new PubRec(packet)
      ack.reasonCode = ReasonCodes.NOT_AUTHORIZED
      // The connection stays up (v5), so the authz failure would otherwise be
      // invisible; surface it on clientError for telemetry/alerting (this does
      // not close the connection, unlike the v3/v4 done(err) path below).
      client.broker.emit('clientError', client, err)
      write(client, ack, () => done())
      return
    }
    done(err)
  })
}

// Resolves an MQTT 5.0 inbound Topic Alias. A PUBLISH that carries a non-empty
// topic together with an alias registers (or updates) the mapping; a PUBLISH
// with an empty topic resolves the topic from a previously registered alias.
// The alias is connection-scoped, so it is removed from the packet before the
// message is forwarded to subscribers. [MQTT-3.3.2-7..3.3.2-13]
function resolveTopicAlias (client, packet) {
  const alias = packet.properties.topicAlias
  const max = client.broker.topicAliasMaximum
  if (alias < 1 || alias > max) {
    return new Error(`topic alias ${alias} is out of range (broker topicAliasMaximum is ${max})`)
  }

  if (packet.topic.length > 0) {
    client.topicAliases.set(alias, packet.topic)
  } else {
    const topic = client.topicAliases.get(alias)
    if (topic === undefined) {
      return new Error(`unknown topic alias ${alias}`)
    }
    packet.topic = topic
  }

  delete packet.properties.topicAlias
  return null
}

export default handlePublish
