var mqtt = require('mqtt-packet')
var EE = require('events').EventEmitter
var util = require('util')
var through = require('through2')
var empty = new Buffer(0)
var Packet = require('./packet')
var pump = require('pump')

module.exports = Client

function Client (broker, conn) {
  var that = this

  this.broker = broker
  this.conn = conn
  this.parser = mqtt.parser()
  this.connected = false
  this.clean = true
  this._handling = 0
  this.subscriptions = {}
  this.id = null

  conn.client = this

  this.parser.client = this

  this._parsingBatch = 1
  this._nextId = Math.ceil(Math.random() * 65535)

  this.parser.on('packet', enqueue)

  function nextBatch () {
    var buf = empty
    var client = that

    that._parsingBatch--
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

  this.deliver0 = function deliverQoS0 (_packet, cb) {
    var packet = new Packet(_packet, broker)
    packet.qos = 0
    write(that, packet, cb)
  }

  this.deliver1 = function deliverQoS1 (_packet, cb) {
    var packet = new QoSPacket(_packet, that)
    packet.writeCallback = cb
    broker.persistence.outgoingUpdate(that, packet, writeQoS)
  }

  this.deliver2 = function deliverQoS2 (_packet, cb) {
    var packet = new QoSPacket(_packet, that)
    packet.writeCallback = cb
    broker.persistence.outgoingUpdate(that, packet, writeQoS)
  }
}

function writeQoS (err, client, packet) {
  if (err) {
    // is this right, or we should ignore thins?
    client.emit('error', err)
  } else {
    write(client, packet, packet.writeCallback)
  }
}

function drainRequest (req) {
  req.callback()
}

function onError (err) {
  this.conn.removeAllListeners('error')
  this.conn.on('error', function () {})
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

  function finish () {
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

function enqueue (packet) {
  this.client._parsingBatch++
  process(this.client, packet, this.client._nextBatch)
}

function write (client, packet, done) {
  client.conn.write(mqtt.generate(packet), 'binary', done)
}

function PubAck (packet) {
  this.cmd = 'puback'
  this.messageId = packet.messageId
}

function PubRec (packet) {
  this.cmd = 'pubrec'
  this.messageId = packet.messageId
}

function PubRel (packet) {
  this.cmd = 'pubrel'
  this.messageId = packet.messageId
}

function PubComp (packet) {
  this.cmd = 'pubcomp'
  this.messageId = packet.messageId
}

function handlePublish (client, packet, done) {
  switch (packet.qos) {
    case 2:
      write(client, new PubRec(packet))
      client.broker.persistence.incomingStorePacket(client, packet, done)
      break
    case 1:
      write(client, new PubAck(packet))
      client.broker.publish(packet, done)
      break
    case 0:
      client.broker.publish(packet, done)
      break
    default:
      // nothing to do
  }
}

function process (client, packet, done) {
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
    case 'pubcomp':
    case 'puback':
      handlePuback(client, packet, done)
      break
    case 'pubrel':
      handlePubrel(client, packet, done)
      break
    case 'pubrec':
      handlePubrec(client, packet, done)
      break
    case 'disconnect':
      client.conn.end()
      break
    default:
      client.conn.destroy()
  }
}

function ClientPacketStatus (client, packet) {
  this.client = client
  this.packet = packet
}

var connectActions = [ fetchSubs,
  restoreSubs,
  doConnack,
  emptyQueue
]

function handleConnect (client, packet, done) {
  client.connected = true
  client.clean = packet.clean
  client.id = packet.clientId

  client.broker._series(
    new ClientPacketStatus(client, packet),
    connectActions, {}, done)
}

function fetchSubs (arg, done) {
  if (!this.packet.clean) {
    this.client.broker.persistence.subscriptionsByClient({
      id: this.client.id,
      done: done,
      arg: arg
    }, gotSubs)
  } else {
    this.client.broker.persistence.cleanSubscriptions(
      this.client,
      done)
  }
}

function gotSubs (err, subs, client) {
  if (err) {
    return client.done(err)
  }
  client.arg.subs = subs
  client.done()
}

function restoreSubs (arg, done) {
  if (arg.subs) {
    handleSubscribe(this.client, { subscriptions: arg.subs }, done)
  } else {
    done()
  }
}

function Connack (arg) {
  this.cmd = 'connack'
  this.returnCode = 0
  this.sessionPresent = !!arg.subs // cast to boolean
}

function doConnack (arg, done) {
  write(this.client, new Connack(arg), done)
}

function emptyQueue (arg, done) {
  var client = this.client
  var persistence = client.broker.persistence
  var outgoing = persistence.outgoingStream(client)

  pump(outgoing, through.obj(function (data, enc, next) {
    var packet = new QoSPacket(data, client)
    packet.writeCallback = next
    persistence.outgoingUpdate(client, packet, emptyQueueFilter)
  }), done)
}

function emptyQueueFilter (err, client, packet) {
  var next = packet.writeCallback
  var persistence = client.broker.persistence

  if (err) {
    client.emit('error', err)
    return next()
  }

  if (client.clean) {
    persistence.outgoingClearMessageId(client, packet, next)
  } else {
    write(client, packet, next)
  }
}

function SubscribeState (client, packet, finish, granted) {
  this.client = client
  this.packet = packet
  this.finish = finish
  this.granted = granted
}

function handleSubscribe (client, packet, done) {
  var broker = client.broker
  var subs = packet.subscriptions
  var i
  var length = subs.length
  var granted = []

  for (i = 0; i < length; i++) {
    granted.push(subs[i].qos)
  }

  broker._series(
    new SubscribeState(client, packet, done, granted),
    doSubscribe,
    subs,
    completeSubscribe)
}

function doSubscribe (sub, done) {
  var client = this.client
  var broker = client.broker
  var func = nop

  switch (sub.qos) {
    case 2:
      func = client.deliver2
      break
    case 1:
      func = client.deliver1
      break
    default:
      func = client.deliver0
      break
  }

  client.subscriptions[sub.topic] = sub.qos

  broker.subscribe(sub.topic, func, done)
}

function completeSubscribe (err) {
  var client = this.client
  var broker = client.broker
  var done = this.finish

  if (err) {
    return client.emit('error', err)
  }

  broker._series(this, [storeSubscriptions, doSuback], null, done || nop)
}

function storeSubscriptions (arg, done) {
  var packet = this.packet
  var client = this.client
  var broker = client.broker
  var perst = broker.persistence

  perst.addSubscriptions(client, packet.subscriptions, done)
}

function SubAck (packet, granted) {
  this.cmd = 'suback'
  this.messageId = packet.messageId
  this.granted = granted
}

function doSuback (arg, done) {
  var packet = this.packet
  var client = this.client
  var granted = this.granted

  if (packet.messageId) {
    write(client, new SubAck(packet, granted), done)
  } else {
    done()
  }
}

function handleUnsubscribe (client, packet, done) {
  var broker = client.broker

  broker._series(
    new SubscribeState(client, packet, done, null),
    doUnsubscribe,
    packet.unsubscriptions,
    completeUnsubscribe)
}

function doUnsubscribe (sub, done) {
  var client = this.client
  var broker = client.broker
  var qos = client.subscriptions[sub]

  delete client.subscriptions[sub]

  broker.unsubscribe(
    sub,
    qos === 1 ? client.deliver1 : client.deliver0,
    done)
}

function completeUnsubscribe (err) {
  var packet = this.packet
  var client = this.client
  var done = this.finish

  if (err) {
    return client.emit('error', err)
  }

  if (packet.messageId) {
    var response = {
      cmd: 'unsuback',
      messageId: packet.messageId
    }

    write(client, response, done)
  }
}

function handlePuback (client, packet, done) {
  var persistence = client.broker.persistence
  persistence.outgoingClearMessageId(client, packet, done)
}

var pubrelActions = [
  pubrelGet,
  pubrelPublish,
  pubrelWrite,
  pubrelDel
]
function handlePubrel (client, packet, done) {
  client.broker._series(
    new ClientPacketStatus(client, packet),
    pubrelActions, {}, done)
}

function pubrelGet (arg, done) {
  var persistence = this.client.broker.persistence
  persistence.incomingGetPacket(
    this.client, this.packet, function (err, packet) {
    arg.packet = packet
    done(err)
  })
}

function pubrelPublish (arg, done) {
  this.client.broker.publish(arg.packet, done)
}

function pubrelWrite (arg, done) {
  write(this.client, new PubComp(arg.packet), done)
}

function pubrelDel (arg, done) {
  var persistence = this.client.broker.persistence
  persistence.incomingDelPacket(this.client, arg.packet, done)
}

function handlePubrec (client, packet, done) {
  var pubrel = new PubRel(packet)
  client.broker.persistence.outgoingUpdate(
    client, pubrel,
    function (err) {

      if (err) {
        // TODO is this ok?
        return onError(err)
      }

      write(client, pubrel, done)
    })
}

function QoSPacket (original, client) {
  Packet.call(this, original, client.broker)

  this.writeCallback = nop

  if (!original.messageId) {
    this.messageId = client._nextId
    if (client._nextId === 65535) {
      client._nextId = 0
    } else {
      client._nextId++
    }
  } else {
    this.messageId = original.messageId
  }
}

function nop () {}

util.inherits(QoSPacket, Packet)
