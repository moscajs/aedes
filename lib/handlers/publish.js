import { runSeries, topicLevelCount } from '../utils.js'
import write from '../write.js'

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
  // reject deeply nested topics before any ack/persistence side-effect; see
  // lib/utils.js#topicLevelCount. broker.publish guards the will/API paths.
  if (topicLevelCount(topic) > client.broker.maxTopicLevels) {
    err = new Error('topic has too many levels')
    return done(err)
  }
  runSeries(client, publishActions, packet, done)
}

function enqueuePublish (packet, done) {
  const client = this

  switch (packet.qos) {
    case 2:
      // MQTT-4.3.3-2: Check if we already have this packet by messageId
      client.broker.persistence.incomingGetPacket(client, packet)
        .then(() => {
          // Duplicate packet: just send PUBREC, don't publish again
          write(client, new PubRec(packet), done)
        }, () => {
          // New packet (not found in store): bound the inbound QoS 2 receive
          // window before retaining it, so a client that keeps sending fresh
          // message identifiers while withholding PUBREL cannot grow its
          // incoming persistence map toward the 16-bit messageId ceiling.
          //
          // The slot is reserved here, synchronously, and keyed by messageId.
          // Both matter: a whole socket read chunk is dispatched concurrently
          // (see enqueue in lib/client.js), so reserving after the await lets
          // the entire chunk past the check; and keying by messageId means a
          // DUP retransmission of a packet already in flight re-reserves its
          // own slot instead of consuming a second one.
          const inflight = client._inboundInflight
          const limit = client.broker.maxInflightInbound
          if (limit > 0 && !inflight.has(packet.messageId) && inflight.size >= limit) {
            // MQTT 3.1/3.1.1 has no reason code to carry, so drop the connection
            return done(new Error('maxInflightInbound exceeded: ' + limit + ' inbound QoS 2 messages already awaiting PUBREL'))
          }
          inflight.add(packet.messageId)

          // store first, then publish. This ensures if storage fails, the
          // message hasn't been delivered yet, preventing duplicate delivery on
          // retransmission.
          client.broker.persistence.incomingStorePacket(client, packet)
            .then(() => {
              client.broker.publish(packet, client, (err) => {
                if (err) { return done(err) }
                write(client, new PubRec(packet), done)
              })
            }, (err) => {
              // nothing was stored, so the slot must go back
              inflight.delete(packet.messageId)
              done(err)
            })
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
  this.broker.authorizePublish(this, packet, done)
}

export default handlePublish
