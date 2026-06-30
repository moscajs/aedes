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
      // The disconnect is authoritative: it closes the connection (detaching the
      // reader), so finishing the batch with done() — not done(err) — is correct;
      // no further packets on this batch will be processed.
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
  // [MQTT-3.3.2-14] The MQTT 5.0 Response Topic must be a publish topic name, so
  // it must not contain wildcard characters.
  const responseTopic = packet.properties?.responseTopic
  if (responseTopic !== undefined && (responseTopic.indexOf('#') > -1 || responseTopic.indexOf('+') > -1)) {
    return done(new Error('wildcard is not allowed in Response Topic'))
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
  // v3/v4 have no reason-code handling here, so pass `done` straight through —
  // no per-message wrapper closure on the broker's busiest path.
  if (client.version !== 5) {
    return client.broker.authorizePublish(client, packet, done)
  }
  client.broker.authorizePublish(client, packet, function (err) {
    if (!err) {
      return done()
    }
    // MQTT 5.0: rather than dropping the connection on an authz failure, keep
    // it up and drop the message. A QoS > 0 publish is answered with a 0x87
    // (Not authorized) PUBACK/PUBREC; a QoS 0 publish has no acknowledgement to
    // carry a reason code, so it is dropped silently. Either way the failure is
    // surfaced on clientError for telemetry (v3/v4 instead take the done(err)
    // fast path above, which closes the connection).
    packet._notAuthorized = true
    client.broker.emit('clientError', client, err)
    if (packet.qos > 0) {
      const ack = packet.qos === 1 ? new PubAck(packet) : new PubRec(packet)
      ack.reasonCode = ReasonCodes.NOT_AUTHORIZED
      write(client, ack, () => done())
    } else {
      done()
    }
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
    // Only register a topic the later PUBLISH validation will accept — never
    // store a wildcard/invalid topic in the connection's alias map. An invalid
    // topic still falls through to handlePublish's checks, which reject it.
    if (packet.topic.indexOf('#') === -1 && packet.topic.indexOf('+') === -1) {
      client._topicAliases.set(alias, packet.topic)
    }
  } else {
    const topic = client._topicAliases.get(alias)
    if (topic === undefined) {
      return new Error(`unknown topic alias ${alias}`)
    }
    packet.topic = topic
  }

  // Strip the connection-scoped alias before the packet is forwarded. Assign
  // `undefined` rather than `delete`: the properties object is reference-copied
  // into every fanout packet, and `delete` would transition it into dictionary
  // mode, deopting property access for all subscribers.
  packet.properties.topicAlias = undefined
  return null
}

export default handlePublish
