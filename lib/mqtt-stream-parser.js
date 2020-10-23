'use strict'
const mqtt = require('mqtt-packet')
const { through } = require('./utils')

module.exports = MqttStreamParser

function MqttStreamParser (client, options) {
  if (!options) options = {}

  const stream = through(process)
  const parser = mqtt.parser(options)

  parser.on('packet', push)
  parser.on('error', (err) => client.emit('error', err))
  this._parser = parser

  stream.on('error', stream.end.bind(stream))

  function process (chunk, enc, cb) {
    parser.parse(chunk)
    cb()
  }
  function push (packet) {
    stream.push(packet)
  }
  return stream
}
