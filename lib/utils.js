import { Transform } from 'stream'

export function noop () { }

// The routing libraries (mqemitter and the persistence trie) are backed by
// qlobber, which splits a topic on '/' and throws `too many words` once the
// number of levels exceeds its `max_words` limit (default 100). That throw is
// synchronous and uncaught, so a single deeply nested topic would crash the
// broker. We mirror qlobber's level count here (levels === split('/').length)
// to reject such topics before they reach qlobber. The '/' separator is the
// mqemitter/aedes-persistence default and is not configurable through aedes.
// Non-string topics have no level count; return 0 so the caller's own empty/
// invalid-topic checks handle them instead of this throwing a TypeError.
export function topicLevelCount (topic) {
  if (typeof topic !== 'string') return 0
  let levels = 1
  for (let i = 0; i < topic.length; i++) {
    if (topic.charCodeAt(i) === 47) levels++ // '/'
  }
  return levels
}

export function validateTopic (topic, message, maxTopicLevels) {
  if (!topic || topic.length === 0) { // [MQTT-3.8.3-3]
    return new Error('impossible to ' + message + ' to an empty topic')
  }

  // Reject deeply nested topics at the protocol boundary, before any
  // persistence side-effect or qlobber call. See topicLevelCount above.
  if (maxTopicLevels && topicLevelCount(topic) > maxTopicLevels) {
    return new Error('topic has too many levels')
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
