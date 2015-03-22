
var mqtt    = require('mqtt-packet')
  , EE      = require('events').EventEmitter
  , util    = require('util')
  , empty   = new Buffer(0)
  , Packet  = require('./packet')

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

  this._parsingBatch  = 1
  this._nextId = Math.ceil(Math.random * 65535)

  this.parser.on('packet', enqueue)

  function nextBatch() {
    var buf     = empty
      , client  = that

    that._parsingBatch--;
    if (that._parsingBatch <= 0) {
      that._parsingBatch = 0
      buf = client.conn.read(null)

      if (buf) {
        client.parser.parse(buf)
      }
    }
  }
  this._nextBatch = nextBatch

  nextBatch()

  conn.on('readable', nextBatch)
  conn.on('error', this.emit.bind(this, 'error'))
  this.parser.on('error', this.emit.bind(this, 'error'))

  this.on('error', onError)

  this.conn.on('close', this.close.bind(this))

  this.deliver0 = function deliverQoS0(_packet, cb) {
    var packet = new Packet(_packet, broker)
    packet.qos = 0
    write(that, packet, cb)
  }

  this.deliver1 = function deliverQoS1(_packet, cb) {
    var packet = new QoSPacket(_packet, that)
    write(that, packet, cb)
  }
}

function drainRequest(req) {
  req.callback()
}

function onError(err) {
  this.conn.removeAllListeners('error')
  this.conn.on('error', function() {})
  // hack to clean up the write callbacks in case of error
  // supports streams2 & streams3, so node 0.10, 0.11, and iojs
  var state = this.conn._writableState
  var list = state.getBuffer && state.getBuffer() || state.buffer
  list.forEach(drainRequest)
  this.broker.emit('clientError', this, err)
  this.close()
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
  this.client._parsingBatch++;
  process(this.client, packet, this.client._nextBatch)
}

function write(client, packet, done) {
  client.conn.write(mqtt.generate(packet), 'binary', done)
}

function handlePublish(client, packet, broker, done) {
  switch (packet.qos) {
    case 1:
      write(client, {
          cmd: 'puback'
        , qos: 1
        , messageId: packet.messageId
      })
      break
    default:
      // nothing to do
  }

  broker.publish(packet, done)
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
      handlePublish(client, packet, broker, done)
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
    , subs    = packet.subscriptions
    , i
    , length  = subs.length
    , granted = []

  for (i = 0; i < length; i++) {
    subs[i].qos = subs[i].qos > 0? 1 : 0
    granted.push(subs[i].qos)
    client.subscriptions[subs[i].topic] = subs[i].qos
    broker.subscribe(
        subs[i].topic
      , subs[i].qos === 1? client.deliver1 : client.deliver0
      , subscribeDone
    )
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
  doUnsubscribe(client, packet.unsubscriptions, function replyUnsubscribe() {
    var response = {
          cmd: 'unsuback'
        , messageId: packet.messageId
      }

    write(client, response, done)
  })
}

function doUnsubscribe(client, subs, done) {
  var broker  = client.broker
    , i
    , length  = subs.length
    , qos = -1

  for (i = 0; i < length; i++) {
    qos = client.subscriptions[subs[i]]
    delete client.subscriptions[subs[i]]
    broker.unsubscribe(
        subs[i]
      , qos === 1? client.deliver1 : client.deliver0
      , complete)
  }

  function complete() {
    length--
    if (length === 0) {
      done()
    }
  }
}

function QoSPacket(original, client) {
  Packet.call(this, original, client.broker)

  this.messageId = client._nextId
  if (client._nextId === 65535) {
    client._nextId = 0
  } else {
    client._nextId++
  }
}

util.inherits(QoSPacket, Packet)
