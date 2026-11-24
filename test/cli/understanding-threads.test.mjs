// Where a concern's thread goes (cli/understanding/threads.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { concernPlace } = await cliModule('threads')

test('concernPlace: the line the concern names (found again by its text), else the question\'s last line', () => {
  const q = {
    id: 'q1', file: 'api/r.js', start: 50, end: 62, concern: { text: 'The stock update adds every unit back.', flagged: true },
    attempts: [{ verdict: 'pass', concern: 'The stock update adds every unit back.', links: [{ phrase: 'The stock update', file: 'api/r.js', start: 61, end: 61, text: '    await stock()' }] }],
  }
  assert.deepEqual(concernPlace(q), { file: 'api/r.js', line: 61 })
  // The named line moved to 64: found by its text.
  const moved = Array.from({ length: 70 }, (_, i) => (i === 63 ? '    await stock()' : `x${i}`))
  assert.deepEqual(concernPlace(q, () => moved), { file: 'api/r.js', line: 64 })
  assert.deepEqual(concernPlace({ ...q, attempts: [] }), { file: 'api/r.js', line: 62 })
})
