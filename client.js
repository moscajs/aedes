
var mqtt  = require('mqtt-packet')
  , EE    = require('events').EventEmitter
  , util  = require('util')

module.exports = Client

function Client(broker, conn) {
  this.broker       = broker
  this.conn         = conn
  this.parser       = mqtt.parser()
  this.connected    = false
  this._handling    = 0

  conn.client = this

  this.parser.on('packet', enqueue)
  this.parser.client = this

  this.queue = []

  var that = this
  var skipNext = false
  function oneAtATime() {
    var queue = that.queue

    if (!skipNext && !(queue.length % 1000)) {
      skipNext = true
      setImmediate(oneAtATime)
      return
    }
    skipNext = false

    if (queue.length === 0) {
      skipNext = true
      read.call(that.conn)
    } else {
      process(that, queue.shift(), oneAtATime)
    }
  }
  this._oneAtATime = oneAtATime

  read.call(conn)

  conn.on('error', this.emit.bind(this, 'error'))
  this.parser.on('error', this.emit.bind(this, 'error'))

  this.on('error', function(err) {
    broker.emit('clientError', that, err)
  })
}

util.inherits(Client, EE)

function enqueue(packet) {
  this.client.queue.push(packet)
}

function read() {
  var buf     = this.read()
    , client  = this.client

  if (buf) {
    client.parser.parse(buf)
    client._oneAtATime()
  } else {
    client.conn.once('readable', read)
  }
}

function write(client, packet, done) {
  var conn = client.conn
  if (conn._writableState.ended) {
    conn.emit('error', new Error('connection ended abruptly'))
    done()
  } else if (!conn.write(mqtt.generate(packet))) {
    conn.once('drain', done)
  } else {
    done()
  }
}

function process(client, packet, done) {
  var broker = client.broker

  if (packet.cmd !== 'connect' && !client.connected) {
    client.conn.destroy()
    return
  }

  switch (packet.cmd) {
    case 'connect':
      client.connected = true
      write(client, {
          cmd: 'connack'
        , returnCode: 0
      }, done)
      break
    case 'publish':
      broker.publish(packet, done)
      break
    case 'subscribe':
      broker.subscribe(packet, function(packet, cb) {
        write(client, packet, cb)
      }, function(err) {
        // TODO handle err?

        var response = {
              cmd: 'suback'
            , messageId: packet.messageId
            , granted: packet.subscriptions.map(function() {
                // everything subscribed to QoS 0
                return 0
              })
          }

        write(client, response, done)
      })
      break
    default:
      client.conn.destroy()
      return
  }
}
