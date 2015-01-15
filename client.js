
var mqtt  = require('mqtt-packet')
  , EE    = require('events').EventEmitter
  , util  = require('util')

module.exports = Client

function Client(broker, conn) {
  var that            = this
  var skipNext        = false

  this.broker         = broker
  this.conn           = conn
  this.parser         = mqtt.parser()
  this.connected      = false
  this._handling      = 0
  this.subscriptions  = {}

  conn.client         = this

  this.parser.client  = this

  this.queue          = []


  this.parser.on('packet', enqueue)

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
    that.close()
  })

  this.conn.on('close', this.close.bind(this))

  this.deliver = function(packet, cb) {
    write(that, packet, cb)
  }
}

util.inherits(Client, EE)

Client.prototype.close = function (done) {
  var conn = this.conn

  if (this.connected) {
    doUnsubscribe(this, Object.keys(this.subscriptions), finish)
  } else {
    finish()
  }

  function finish() {
    if (conn.destroy) {
      conn.destroy()
    } else {
      conn.end()
    }
    if (done) {
      done()
    }
  }
}

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
  var broker  = client.broker

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
      handleSubscribe(client, packet, done)
      break
    case 'unsubscribe':
      handleUnsubscribe(client, packet, done)
      break
    case 'disconnect':
      client.conn.end()
    default:
      client.conn.destroy()
  }
}

function handleSubscribe(client, packet, done) {
  var broker  = client.broker
    , deliver = client.deliver
    , subs    = packet.subscriptions
    , i
    , length  = subs.length
    , granted = []

  for (i = 0; i < length; i++) {
    // everything subscribed to QoS 0
    granted.push(0)
    client.subscriptions[subs[i].topic] = subs[i].qos
    broker.subscribe(subs[i].topic, deliver, subscribeDone)
  }

  function subscribeDone(err) {
    // TODO handle err?

    var response = {
          cmd: 'suback'
        , messageId: packet.messageId
        , granted: granted
      }

    write(client, response, complete)
  }

  function complete() {
    length--
    if (length === 0) {
      done()
    }
  }
}

function handleUnsubscribe(client, packet, done) {
  doUnsubscribe(client, packet.unsubscriptions, function() {
    var response = {
          cmd: 'unsuback'
        , messageId: packet.messageId
      }

    write(client, response, done)
  })
}

function doUnsubscribe(client, subs, done) {
  var broker  = client.broker
    , deliver = client.deliver
    , i
    , length  = subs.length

  for (i = 0; i < length; i++) {
    delete client.subscriptions[subs[i]]
    broker.unsubscribe(subs[i], deliver, complete)
  }

  function complete() {
    length--
    if (length === 0) {
      done()
    }
  }
}
