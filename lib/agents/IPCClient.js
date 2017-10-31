
var config = {
  appspace: 'app.',
  socketRoot: '/tmp/',
  networkHost: 'localhost', // should resolve to 127.0.0.1 or ::1 see the table below related to this
  networkPort: 9200,
  encoding: 'utf8',
  rawBuffer: false,
  sync: false,
  silent: false,
  logInColor: true,
  logDepth: 5,
  retry: 500,
  maxRetries: false,
  stopRetrying: false
}

function extend (target) {
  var sources = [].slice.call(arguments, 1)
  sources.forEach(function (source) {
    for (var prop in source) {
      target[prop] = source[prop]
    }
  })
  return target
}

function IPCClient () {
  this.ipc = require('node-ipc')
  console.log('IPC Client Constructor')
  extend(this.ipc.config, config)
}

IPCClient.prototype.connect = createIPCInstance

function createIPCInstance (configObject, target, dataCallback) {
  var that = this
  return new Promise(function (resolve, reject) {
    if (!configObject.id) {
      throw new Error('Id is required')
    } else {
      extend(that.ipc.config, configObject)
    }
    that.ipc.connectTo(
      target,
      function () {
        that.ipc.of[target].on(
          'connect',
          function () {
            that.ipc.log('connected to server: ' + target, that.ipc.config.delay)
            /*
            ipc.of[target].emit(
              'hello from client :)'
            )
            */
            resolve(that.ipc.of[target])
          }
        )
        that.ipc.of[target].on(
          'error',
          function (err) {
            that.ipc.log('## error:', err)
            reject(err)
          }
        )
        that.ipc.of[target].on(
          'disconnect',
          function () {
            that.ipc.log('## Disconnected from server ##')
          }
        )
        if (dataCallback) {
          that.ipc.of[target].on(
            'data',
            dataCallback
          )
        }
      }
    )
  })
}

module.exports = function () {
  return new IPCClient()
}
