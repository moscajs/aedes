import { Transform, Writable } from 'stream'

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

// Nodejs can clear timers in constant time these days
// https://asafdav2.github.io/2017/node-js-timers/
// Running retimers bench.js on Node 24.5 shows retimer to be 1 second faster on 1M invocations.
// hence we can simplify retimer so we don't have to rely on a dependency
export function retimer (fn, ms) {
  let timeout = setTimeout(fn, ms)
  return {
    reschedule (newMs) {
      clearTimeout(timeout)
      timeout = setTimeout(fn, newMs)
    },
    clear () {
      clearTimeout(timeout)
    }
  }
}

export function bulk (fn) {
  return new Writable({
    objectMode: true,
    writev: function (chunks, cb) {
      fn(chunks.map(chunk => chunk.chunk), cb)
    }
  })
}

export const $SYS_PREFIX = '$SYS/'
