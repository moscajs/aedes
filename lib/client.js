
var mqtt    = require('mqtt-packet')
  , EE      = require('events').EventEmitter
  , util    = require('util')
  , through = require('through2')
  , empty   = new Buffer(0)
  , Packet  = require('./packet')
  , pump    = require('pump')

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
  this.id             = null

  conn.client         = this

  this.parser.client  = this

  this._parsingBatch  = 1
  this._nextId        = Math.ceil(Math.random() * 65535)

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
    handleUnsubscribe(
        this
      , { unsubscriptions: Object.keys(this.subscriptions) }
      , finish)
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

function handlePublish(client, packet, done) {
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

  client.broker.publish(packet, done)
}

function process(client, packet, done) {
  var broker  = client.broker

  if (packet.cmd !== 'connect' && !client.connected) {
    client.conn.destroy()
    return
  }

  switch (packet.cmd) {
    case 'connect':
      handleConnect(client, packet, done)
      break
    case 'publish':
      handlePublish(client, packet, done)
      break
    case 'subscribe':
      handleSubscribe(client, packet, done)
      break
    case 'unsubscribe':
      handleUnsubscribe(client, packet, done)
      break
    case 'disconnect':
      client.conn.end()
    case 'puback':
      handlePuback(client, packet, done)
    default:
      client.conn.destroy()
  }
}

function handleConnect(client, packet, done) {
  client.connected = true
  client.id = packet.clientId

  client.broker._series({
      client: client
    , packet: packet
  }, [
      fetchSubs
    , restoreSubs
    , doConnack
    , emptyQueue
  ], {}, done)
}

function fetchSubs(arg, done) {
  var that = this
  if (!this.packet.clean) {
    this.client.broker.persistence.subscriptionsByClient({
        id: this.client.id
      , done: done
      , arg: arg
    }, gotSubs)
  } else {
    this.client.broker.persistence.cleanSubscriptions(
        this.client
      , done)
  }
}

function gotSubs(err, subs, client) {
  if (err) {
    return client.done(err)
  }
  client.arg.subs = subs
  client.done()
}

function restoreSubs(arg, done) {
  if (arg.subs) {
    handleSubscribe(this.client, { subscriptions: arg.subs }, done)
  } else {
    done()
  }
}

function doConnack(arg, done) {
  write(this.client, {
      cmd: 'connack'
    , returnCode: 0
    , sessionPresent: arg.subs ? true : false
  }, done)
}

function emptyQueue(arg, done) {
  var client      = this.client
    , persistence = client.broker.persistence
    , outgoing    = persistence.outgoingStream(client)

  pump(outgoing, through.obj(function (data, enc, next) {
    var packet = new QoSPacket(data, client)
    persistence.outgoingUpdateMessageId(client.id, packet, function () {
      // TODO handle err
      write(client, packet, next)
    })
  }), done)
}

function handleSubscribe(client, packet, done) {
  var broker  = client.broker
    , subs    = packet.subscriptions
    , i
    , length  = subs.length
    , granted = []

  for (i = 0; i < length; i++) {
    subs[i].qos = subs[i].qos > 0 ? 1 : 0
    granted.push(subs[i].qos)
  }

  broker._series({
          client: client
        , packet: packet
        , finish: done
        , granted: granted
      }
    , doSubscribe
    , subs
    , completeSubscribe)
}

function doSubscribe(sub, done) {
  var client  = this.client
    , broker  = client.broker

  client.subscriptions[sub.topic] = sub.qos

  broker.subscribe(
      sub.topic
    , sub.qos === 1? client.deliver1 : client.deliver0
    , done
  )
}

function completeSubscribe(err) {

  var packet  = this.packet
    , client  = this.client
    , broker  = client.broker
    , perst   = broker.persistence
    , done    = this.finish

  if (err) {
    return client.emit('error', err)
  }

  broker._series(this, [storeSubscriptions, doSuback], null, done || nop)
}

function storeSubscriptions(arg, done) {
  var packet  = this.packet
    , client  = this.client
    , broker  = client.broker
    , perst   = broker.persistence

  perst.addSubscriptions(client, packet.subscriptions, done)
}

function doSuback(arg, done) {
  var packet  = this.packet
    , client  = this.client
    , granted = this.granted

  if (packet.messageId) {
    var response = {
          cmd: 'suback'
        , messageId: packet.messageId
        , granted: granted
      }

    write(client, response, done)
  } else {
    done()
  }
}

function handleUnsubscribe(client, packet, done) {
  var broker  = client.broker

  broker._series({
          client: client
        , packet: packet
        , finish: done
      }
    , doUnsubscribe
    , packet.unsubscriptions
    , completeUnsubscribe)
}

function doUnsubscribe(sub, done) {
  var client  = this.client
    , broker  = client.broker
    , qos     = client.subscriptions[sub]

  delete client.subscriptions[sub]

  broker.unsubscribe(
      sub
    , qos === 1? client.deliver1 : client.deliver0
    , done)
}

function completeUnsubscribe(err) {

  var packet  = this.packet
    , client  = this.client
    , done    = this.finish

  if (err) {
    return client.emit('error', err)
  }

  if (packet.messageId) {
    var response = {
          cmd: 'unsuback'
        , messageId: packet.messageId
      }

    write(client, response, done)
  }
}

function handlePuback(client, packet, done) {
  var persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client.id, packet, done)
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

function nop() {}

util.inherits(QoSPacket, Packet)
