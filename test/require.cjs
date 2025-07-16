// a test to see if CJS require still works

const { Aedes } = require('../aedes.js')
const defaultExport = require('../aedes.js')
const { test } = require('tap')

test('test Aedes constructor', function (t) {
  t.plan(1)
  const aedes = new Aedes()
  t.equal(aedes instanceof Aedes, true, 'Aedes constructor works')
})

test('test warning on default export', function (t) {
  t.plan(1)
  t.throws(defaultExport, 'received expected error')
})

test('test aedes.createBroker', (t) => {
  t.plan(1)
  Aedes.createBroker().then((broker) => {
    t.teardown(broker.close.bind(broker))
    t.pass('Aedes.createBroker works')
  })
})
