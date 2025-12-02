import mqtt from 'mqtt-packet'

function write (client, packet, done) {
  let error = null
  if (client.connecting || client.connected) {
    try {
      const result = mqtt.writeToStream(packet, client.conn)
      if (!result && !client.errored) {
        const drainTimeout = client.broker?.opts?.drainTimeout
        if (drainTimeout > 0) {
          // With drain timeout: disconnect slow clients instead of blocking forever
          const timer = setTimeout(() => {
            client.conn.removeListener('drain', onDrain)
            error = new Error('drain timeout')
            client.conn.destroy(error)
            setImmediate(done, error, client)
          }, drainTimeout)
          timer.unref() // Don't keep process alive for this timer
          // ? is it safe to have so many timers?
          function onDrain () {
            clearTimeout(timer)
            done(null, client)
          }
          client.conn.once('drain', onDrain)
        } else {
          // Without drain timeout: wait indefinitely (original behavior)
          client.conn.once('drain', done)
        }
        return
      }
    } catch (e) {
      error = new Error('packet received not valid')
    }
  } else {
    error = new Error('connection closed')
  }

  setImmediate(done, error, client)
}

export default write
