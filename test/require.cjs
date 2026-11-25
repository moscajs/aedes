// a test to see if CJS require still works
const { test } = require('node:test')
const aedesModule = require('../aedes.js')
const { Aedes } = aedesModule

test('test Aedes constructor', (t) => {
  t.plan(1)
  const aedes = new Aedes()
  t.assert.equal(aedes instanceof Aedes, true, 'Aedes constructor works')
})

test('only the named Aedes export is exposed', (t) => {
  t.plan(1)
  t.assert.deepStrictEqual(Object.keys(aedesModule), ['Aedes'])
})

test('test aedes.createBroker', async (t) => {
  t.plan(1)
  const broker = await Aedes.createBroker()
  t.after(() => broker.close())
  t.assert.ok(true, 'Aedes.createBroker works')
})
