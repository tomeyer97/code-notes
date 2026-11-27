import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruMap } from '../src/core/lruMap'

test('LruMap: at most max entries; the least recently used goes first', () => {
  const m = new LruMap<string, number>(2)
  m.set('a', 1).set('b', 2)
  assert.equal(m.get('a'), 1, 'a is now the most recent')
  m.set('c', 3)
  assert.deepEqual([m.has('a'), m.has('b'), m.has('c')], [true, false, true])
  m.set('a', 10)
  m.set('d', 4)
  assert.deepEqual([m.get('a'), m.has('c'), m.get('d'), m.size], [10, false, 4, 2])
  assert.equal(m.get('zzz'), undefined)
  assert.equal(m.delete('a'), true)
  m.clear()
  assert.equal(m.size, 0)
})
