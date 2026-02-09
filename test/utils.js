import { test } from 'node:test'
import { runFall, batch } from '../lib/utils.js'
import { setTimeout } from 'timers/promises'

test('runFall works ok', function (t) {
  t.plan(5)

  function a (a, cb) {
    t.assert.equal(a, 'a', 'first function 1st arg matches')
    cb(null, 'b')
  }

  function b (b, cb) {
    t.assert.equal(b, 'b', 'second function 1st arg matches')
    cb(null, 'c')
  }

  function c (c, cb) {
    t.assert.equal(c, 'c', 'third function 1st arg matches')
    cb(null, 'd')
  }
  function done (err, d) {
    t.assert.equal(err, null, 'no error')
    t.assert.equal(d, 'd', 'done argument matches')
  }
  const fall = runFall([a, b, c])
  fall('a', done)
})

for (let i = 1; i < 4; i++) {
  test(`runFall with function ${i} returning error`, function (t) {
    t.plan(1 + i)

    function isErr (n) {
      if (n === i) {
        return 'oops'
      }
      return null
    }

    function a (a, cb) {
      t.assert.equal(a, 'a', 'function a arg matches')
      cb(isErr(1), 'b')
    }

    function b (b, cb) {
      t.assert.equal(b, 'b', 'function b arg matches')
      cb(isErr(2), 'c')
    }

    function c (c, cb) {
      t.assert.equal(c, 'c', 'function c arg matches')
      cb(isErr(3), 'd')
    }
    function done (err, d) {
      t.assert.equal(err, 'oops')
    }
    const fall = runFall([a, b, c])
    fall('a', done)
  })
}

// generator helper to test batch
async function * generator (numItems) {
  let ctr = 0
  while (ctr < numItems) {
    yield ctr++
  }
}

for (const [label, numItems, numBatches] of [
  ['< highWaterMark', 10, 1],
  ['> highwatermark exact batch size', 32, 2],
  ['> highwatermark with remainder', 100, 7],
]) {
  test(`batch works with number of items ${label}`, async (t) => {
    t.plan(2 + numItems)
    const results = []
    const fn = async (i) => {
      await setTimeout(10)
      results.push(i * 2)
    }
    let numBatch = 0
    for await (const items of (batch(generator(numItems), fn, 16))) {
      await Promise.all(items)
      numBatch++
    }
    t.assert.equal(numBatch, numBatches, 'all batches')
    t.assert.equal(results.length, numItems, 'all items')
    for (let i = 0; i < numItems; i++) {
      t.assert.equal(results[i], i * 2)
    }
  })
}

test('test batch function trowing error', async (t) => {
  t.plan(2)
  const numItems = 100

  const fn = async (i) => {
    await setTimeout(10)
    if (i === 20) {
      throw new Error('item 20 failed')
    }
  }
  let numBatches = 0

  async function runBatches () {
    for await (const items of (batch(generator(numItems), fn, 16))) {
      numBatches++
      await Promise.all(items)
    }
  }

  // the extra promise is to make sure the test waits for the error
  await new Promise(resolve => {
    runBatches().catch(async err => {
      t.assert.equal(err.message, 'item 20 failed')
      t.assert.equal(numBatches, 2, 'correct number of batches before error was thrown')
      resolve()
    })
  })
})
