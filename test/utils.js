import { test } from 'node:test'
import { runFall, batch, once, runSeries, runParallel } from '../lib/utils.js'
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

test('test batch function throwing error', async (t) => {
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

// Tests for once() function - critical defensive pattern against double-callback
test('once() prevents double callback invocation', function (t) {
  t.plan(4)

  let callCount = 0
  let lastError = null

  function testFn (err) {
    callCount++
    lastError = err
  }

  const wrappedFn = once(testFn)

  const err1 = new Error('first call')
  wrappedFn(err1)
  t.assert.equal(callCount, 1, 'callback invoked on first call')
  t.assert.equal(lastError, err1, 'error passed through on first call')

  const err2 = new Error('second call - should be ignored')
  wrappedFn(err2)
  t.assert.equal(callCount, 1, 'callback still invoked only once after second call')
  t.assert.equal(lastError, err1, 'second error was ignored, first error preserved')
})

test('once() prevents double callback with null error', function (t) {
  t.plan(2)

  let callCount = 0
  const wrappedFn = once(() => { callCount++ })

  wrappedFn(null)
  t.assert.equal(callCount, 1, 'callback invoked on first call with null')

  wrappedFn(null)
  t.assert.equal(callCount, 1, 'callback not invoked on second call with null')
})

// Tests for runSeries() function - critical for sequential handler execution
test('runSeries executes functions in order', function (t) {
  t.plan(4)

  const execution = []

  function action1 (packet, next) {
    execution.push(1)
    t.assert.equal(execution.length, 1, 'action1 executed first')
    next()
  }

  function action2 (packet, next) {
    execution.push(2)
    t.assert.equal(execution.length, 2, 'action2 executed second')
    next()
  }

  function action3 (packet, next) {
    execution.push(3)
    t.assert.equal(execution.length, 3, 'action3 executed third')
    next()
  }

  const done = function (err) {
    if (err) throw err
    t.assert.deepEqual(execution, [1, 2, 3], 'all actions executed in order')
  }

  const state = {}
  runSeries(state, [action1, action2, action3], {}, done)
})

test('runSeries stops on first error', function (t) {
  t.plan(3)

  const execution = []

  function action1 (packet, next) {
    execution.push(1)
    next()
  }

  function action2 (packet, next) {
    execution.push(2)
    const err = new Error('action2 failed')
    next(err)
  }

  function action3 (packet, next) {
    execution.push(3)
    next()
  }

  const done = function (err) {
    t.assert.equal(err.message, 'action2 failed', 'error from action2 passed to done')
    t.assert.deepEqual(execution, [1, 2], 'action3 not executed after error')
    t.assert.equal(execution.length, 2, 'stopped execution at action2')
  }

  const state = {}
  runSeries(state, [action1, action2, action3], {}, done)
})

test('runSeries calls done with no error on success', function (t) {
  t.plan(2)

  let doneCallCount = 0

  function action1 (packet, next) {
    next()
  }

  const done = function (err) {
    doneCallCount++
    t.assert.equal(err, undefined, 'done called with no error on success')
  }

  const state = {}
  runSeries(state, [action1], {}, done)
  t.assert.equal(doneCallCount, 1, 'done was called exactly once')
})

test('runSeries binds this context to actions', function (t) {
  t.plan(2)

  let contextChecked = false

  function action1 (packet, next) {
    t.assert.equal(this.clientId, 'test-client', 'this context preserved in action')
    contextChecked = true
    next()
  }

  const done = function (err) {
    if (err) throw err
    t.assert.ok(contextChecked, 'action was executed with correct context')
  }

  const state = { clientId: 'test-client' }
  runSeries(state, [action1], {}, done)
})

test('runSeries handles empty actions array', function (t) {
  t.plan(1)

  const done = function (err) {
    t.assert.equal(err, undefined, 'done called immediately with no error for empty array')
  }

  const state = {}
  runSeries(state, [], {}, done)
})

// Tests for runParallel() function - fastparallel-style fan-out used by subscribe/unsubscribe
test('runParallel calls done once after all items complete', function (t) {
  t.plan(3)

  const processed = []

  function action (item, next) {
    processed.push(item)
    // resolve asynchronously to exercise the concurrent path
    setImmediate(next)
  }

  return new Promise(resolve => {
    let doneCallCount = 0
    runParallel({}, action, [1, 2, 3], function (err) {
      doneCallCount++
      t.assert.equal(err, undefined, 'done called with no error on success')
      t.assert.deepEqual(processed.slice().sort(), [1, 2, 3], 'every item was processed')
      t.assert.equal(doneCallCount, 1, 'done was called exactly once')
      resolve()
    })
  })
})

test('runParallel stops on first error and ignores later callbacks', function (t) {
  t.plan(2)

  function action (item, next) {
    if (item === 2) {
      return setImmediate(() => next(new Error('item 2 failed')))
    }
    setImmediate(next)
  }

  return new Promise(resolve => {
    let doneCallCount = 0
    runParallel({}, action, [1, 2, 3], function (err) {
      doneCallCount++
      t.assert.equal(err.message, 'item 2 failed', 'first error passed to done')
      // wait a tick so any straggler completions would have a chance to re-invoke done
      setImmediate(() => {
        t.assert.equal(doneCallCount, 1, 'done called exactly once despite remaining completions')
        resolve()
      })
    })
  })
})

test('runParallel binds this context to fn', function (t) {
  t.plan(2)

  let contextChecked = false

  function action (item, next) {
    t.assert.equal(this.clientId, 'test-client', 'this context preserved in fn')
    contextChecked = true
    next()
  }

  const done = function (err) {
    if (err) throw err
    t.assert.ok(contextChecked, 'fn was executed with correct context')
  }

  runParallel({ clientId: 'test-client' }, action, [1], done)
})

test('runParallel handles empty items array', function (t) {
  t.plan(1)

  const done = function (err) {
    t.assert.equal(err, undefined, 'done called immediately with no error for empty array')
  }

  runParallel({}, () => t.assert.fail('fn should not be called'), [], done)
})
