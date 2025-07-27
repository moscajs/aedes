// a test to see if CJS require still works
const { test } = require('node:test')
const { Aedes } = require('../aedes.js')
const defaultExport = require('../aedes.js')

test('test Aedes constructor', (t) => {
  t.plan(1)
  const aedes = new Aedes()
  t.assert.equal(aedes instanceof Aedes, true, 'Aedes constructor works')
})

test('test warning on default export', (t) => {
  t.plan(1)
  t.assert.throws(() => defaultExport(), 'received expected error')
})

test('test aedes.createBroker', async (t) => {
  t.plan(1)
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  t.assert.ok(true, 'Aedes.createBroker works')
})
