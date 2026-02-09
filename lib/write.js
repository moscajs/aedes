import mqtt from 'mqtt-packet'

/**
 * Handle drain event - called when socket becomes writable again
 * Clears the timer and completes all pending drain callbacks
 */
function onDrain (client) {
  // Clear the single per-client timer
  if (client._drainTimer) {
    clearTimeout(client._drainTimer)
    client._drainTimer = null
  }

  // Complete all pending drain callbacks
  const pending = client._pendingDrains
  client._pendingDrains = []
  for (let i = 0; i < pending.length; i++) {
    setImmediate(pending[i], null, client)
  }
}

/**
 * Handle drain timeout - called when client fails to drain within timeout
 * Disconnects the client and fails all pending callbacks
 */
function onDrainTimeout (client) {
  client._drainTimer = null

  // Remove drain listener to prevent it firing after disconnect
  client.conn.removeListener('drain', client._onDrainBound)

  // Fail all pending callbacks
  const error = new Error('drain timeout')
  const pending = client._pendingDrains
  client._pendingDrains = []
  for (let i = 0; i < pending.length; i++) {
    setImmediate(pending[i], error, client)
  }

  // Disconnect the slow client
  client.conn.destroy(error)
}

function write (client, packet, done) {
  let error = null
  if (client.connecting || client.connected) {
    try {
      const result = mqtt.writeToStream(packet, client.conn)
      if (!result && !client.errored) {
        const drainTimeout = client.broker?.opts?.drainTimeout
        if (drainTimeout > 0) {
          // Per-client coalesced timer approach:
          // Only create ONE timer per client, regardless of pending writes

          // Add this callback to pending queue
          client._pendingDrains.push(done)

          // If no timer exists, create one and set up drain listener
          if (!client._drainTimer) {
            // Create bound drain handler (if not already created)
            if (!client._onDrainBound) {
              client._onDrainBound = onDrain.bind(null, client)
            }

            // Set up single drain listener
            client.conn.once('drain', client._onDrainBound)

            // Create single timer for this client
            client._drainTimer = setTimeout(
              onDrainTimeout,
              drainTimeout,
              client
            )
            client._drainTimer.unref() // Don't keep process alive
          }
          // else: timer already running, just queued the callback
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
