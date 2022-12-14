'use strict'

const { Transform, Writable } = require('stream')

function validateTopic (topic, message) {
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

function through (transform) {
  return new Transform({
    objectMode: true,
    transform
  })
}

function bulk (fn) {
  return new Writable({
    objectMode: true,
    writev: function (chunks, cb) {
      fn(chunks.map(chunk => chunk.chunk), cb)
    }
  })
}

module.exports = {
  validateTopic,
  through,
  bulk,
  $SYS_PREFIX: '$SYS/'
}
