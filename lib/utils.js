import { Transform } from 'stream'

export function noop () { }

// MQTT 5.0 Request Problem Information [MQTT-3.1.2-29]: build the `properties`
// block carrying a Reason String for an outgoing ACK (PUBACK / PUBREC / PUBREL /
// PUBCOMP / SUBACK / UNSUBACK). Returns undefined — so no properties block is
// emitted — for non-v5 clients, when there is no reason string, or when the
// client set Request Problem Information to 0 (it then must not receive a Reason
// String or User Properties on packets other than PUBLISH/CONNACK/DISCONNECT).
export function ackProperties (client, reasonString) {
  if (client.version !== 5 || !reasonString || client._requestProblemInformation === false) {
    return undefined
  }
  return { reasonString }
}

// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1 ms, firing
// almost immediately. MQTT 5.0 session-expiry / will-delay intervals are uint32
// seconds (up to ~136 years), so a raw setTimeout would wipe long-lived sessions
// and fire delayed wills early.
export const MAX_TIMEOUT_MS = 2147483647

// Arms a timer that survives delays beyond setTimeout's cap by re-arming in
// chunks. Returns a handle whose clear() cancels whichever chunk is pending.
export function armLongTimer (delayMs, onFire) {
  // Guard against a stray non-finite/negative delay: setTimeout(NaN) coerces to
  // 0 and the re-arm math (NaN - NaN) would fire onFire immediately — a timer
  // that silently fires "now" instead of in the future is a bad failure mode.
  if (!Number.isFinite(delayMs)) {
    throw new TypeError('armLongTimer: delayMs must be a finite number')
  }
  delayMs = Math.max(0, delayMs)
  let timer
  const schedule = (remaining) => {
    const chunk = Math.min(remaining, MAX_TIMEOUT_MS)
    timer = setTimeout(() => {
      const left = remaining - chunk
      if (left > 0) {
        schedule(left)
      } else {
        onFire()
      }
    }, chunk)
    if (typeof timer.unref === 'function') timer.unref()
  }
  schedule(delayMs)
  return { clear () { clearTimeout(timer) } }
}

// MQTT remaining-length is a Variable Byte Integer encoded in 1-4 bytes; each
// added byte covers a 7-bit larger range. These are the value breakpoints at
// which the field grows by one byte. [MQTT-2.2.3]
const REMAINING_LENGTH_2_BYTES = 128 // 2^7
const REMAINING_LENGTH_3_BYTES = 16384 // 2^14
const REMAINING_LENGTH_4_BYTES = 2097152 // 2^21

// Total wire size of a packet from its parsed remaining-length: fixed header
// byte (1) + the remaining-length field bytes + the remaining length itself.
export function packetWireSize (remaining) {
  remaining = remaining || 0
  let lengthBytes = 1
  if (remaining >= REMAINING_LENGTH_2_BYTES) lengthBytes = 2
  if (remaining >= REMAINING_LENGTH_3_BYTES) lengthBytes = 3
  if (remaining >= REMAINING_LENGTH_4_BYTES) lengthBytes = 4
  return 1 + lengthBytes + remaining
}

export function validateTopic (topic, message) {
  if (!topic || topic.length === 0) { // [MQTT-3.8.3-3]
    return new Error('impossible to ' + message + ' to an empty topic')
  }

  const end = topic.length - 1
  const endMinus = end - 1
  const slashInPreEnd = endMinus > 0 && topic.charCodeAt(endMinus) !== 47

  for (let i = 0; i < topic.length; i++) {
    switch (topic.charCodeAt(i)) {
      case 35: { // #
        const notAtTheEnd = i !== end
        if (notAtTheEnd || slashInPreEnd) {
          return new Error('# is only allowed in ' + message + ' in the last position')
        }
        break
      }
      case 43: { // +
        const pastChar = i < end - 1 && topic.charCodeAt(i + 1) !== 47
        const preChar = i > 1 && topic.charCodeAt(i - 1) !== 47
        if (pastChar || preChar) {
          return new Error('+ is only allowed in ' + message + ' between /')
        }
        break
      }
    }
  }
}

export function through (transform) {
  return new Transform({
    objectMode: true,
    transform
  })
}

export function runFall (fns) {
  // run functions in fastfall style, only need the single argument function
  return function (arg, cb) {
    let i = 0
    const ctx = this
    function next (err, nextarg) {
      if (err || i === fns.length) {
        if (typeof cb === 'function') {
          cb.call(ctx, err, nextarg)
        }
        return
      }
      const fn = fns[i++]
      fn.call(ctx, nextarg, next)
    }
    next(null, arg)
  }
}

export function runSeries (state, actions, packet, done) {
  // runSeries runs functions in fastseries style
  done = (done || noop).bind(state)
  let i = 0
  function next (err) {
    if (err || i === actions.length) return done(err)
    actions[i++].call(state, packet, next)
  }
  next()
}

export function runParallel (state, fn, items, done) {
  // runParallel runs fn over every item in fastparallel style: fan them all
  // out concurrently and invoke done once — on the first error, or after all
  // have completed. Used instead of Promise.all(items.map(...)) so we don't
  // allocate a promise per item on the (control-path) subscribe/unsubscribe.
  done = (done || noop).bind(state)
  let remaining = items.length
  if (remaining === 0) return done()
  let finished = false
  function cb (err) {
    if (finished) return
    if (err) {
      finished = true
      return done(err)
    }
    if (--remaining === 0) {
      finished = true
      done()
    }
  }
  for (let i = 0; i < items.length; i++) {
    fn.call(state, items[i], cb)
  }
}

export function once (fn) {
  let called = false
  return function (err) {
    /* c8 ignore next -- guard against double-callback in async error paths */
    if (called) return
    called = true
    fn(err)
  }
}

/**
 * Async generator that groups items from a readable into batches.
 * Note: `fn(chunk)` is invoked eagerly for each item in the batch and
 * the generator yields an array of the results (often promises). Callers
 * must `await Promise.all(batch)` to apply backpressure before proceeding
 * to the next yielded batch.
 */
export async function * batch (readable, fn, batchSize) {
  let chunks = []
  for await (const chunk of readable) {
    chunks.push(fn(chunk))
    if (chunks.length === batchSize) {
      yield chunks
      chunks = []
    }
  }
  // if chunks is half full when the iterator ends
  if (chunks.length > 0) {
    yield chunks
  }
}

export const $SYS_PREFIX = '$SYS/'
