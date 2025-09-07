import { Transform } from 'stream'

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

export async function * batch (readable, fn, batchSize) {
  let chunks = []
  for await (const chunk of readable) {
    chunks.push(fn(chunk))
    if (chunks.length === batchSize) {
      yield (chunks)
      chunks = []
    }
  }
  // if chunks is half full when the iterator ends
  if (chunks.length > 0) {
    yield chunks
  }
}

export const $SYS_PREFIX = '$SYS/'
