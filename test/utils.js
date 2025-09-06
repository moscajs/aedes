import { test } from 'node:test'
import { runFall } from '../lib/utils.js'

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
