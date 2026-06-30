// Standalone aedes broker used by the MQTT compatibility workflow.
//
// It boots the broker from *this branch* on a plain-TCP port so the Eclipse Paho
// interoperability suite (tools/mqtt-compat/run_compat.py) can drive it as an
// external broker. v5 capabilities the suite exercises are enabled here so the
// reported score reflects real broker ability, not a broker started with features
// switched off (e.g. inbound topic aliases are a no-op when topicAliasMaximum: 0).
//
// Usage: MQTT_PORT=1883 node tools/mqtt-compat/broker.js
import { createServer } from 'node:net'
import { Aedes } from '../../aedes.js'

const port = Number(process.env.MQTT_PORT) || 1883

const broker = await Aedes.createBroker({
  // Enable inbound topic aliases, off by default, so test_client_topic_alias
  // reflects real broker ability rather than a disabled feature.
  topicAliasMaximum: 65535
  // NOTE: deliberately NOT setting keepaliveLimit. It would let the v5
  // test_server_keep_alive pass, but it currently makes every MQTT 3.1.1 CONNECT
  // fail with reason code 6 (aedes tries to apply a Server Keep Alive that 3.1.1
  // has no field for) — a far worse trade. maximumPacketSize / receiveMaximum /
  // sessionExpiryIntervalLimit are likewise left at their defaults (0 = no cap);
  // the suite drives its own client-side limits via CONNECT properties.
})

// The Paho `test_subscribe_failure` (v3.1.1 and v5) subscribes to a topic that is
// "not allowed to be subscribed to" and asserts the broker answers with SUBACK
// reason code 0x80. That is a broker-configuration feature, not a default: aedes
// supports it via authorizeSubscribe (return a null subscription -> granted 0x80),
// and the Paho reference broker ships with exactly this rule. Mirror it here so
// the test measures aedes's capability rather than the absence of a default ACL.
const NO_SUBSCRIBE_TOPIC = 'test/nosubscribe'
broker.authorizeSubscribe = function (client, sub, callback) {
  if (sub.topic === NO_SUBSCRIBE_TOPIC) {
    callback(null, null) // deny -> SUBACK 0x80
    return
  }
  callback(null, sub)
}

const server = createServer(broker.handle)

broker.on('clientError', (client, err) => {
  console.error('clientError', client?.id, err.message)
})

// Fail loudly (e.g. EADDRINUSE) instead of letting an unhandled 'error' event
// become an uncaught exception; the workflow's readiness probe then reports the
// broker never came up.
server.on('error', (err) => {
  console.error(`broker server error: ${err.message}`)
  process.exit(1)
})

server.listen(port, () => {
  console.error(`aedes listening on ${port}`)
})

function shutdown () {
  server.close()
  broker.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
