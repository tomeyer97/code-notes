// A check thread's link to its question (src/check/threadLink.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Note } from '../src/notes/store'
import { isCheck, linkOf, sameQuestion, textHash } from '../src/check/threadLink'
import { questionOf } from './checkFixtures'

const note = (extra: Record<string, unknown> | undefined, first = '') =>
  ({ data: { extra, messages: [{ author: 'x', body: first }] } }) as unknown as Note

test('a check thread links its check file and question; another note does not', () => {
  const n = note({ check: { file: 'understanding/feat.json', q: 'q1' } })
  assert.deepEqual([isCheck(n), linkOf(n)?.q], [true, 'q1'])
  assert.deepEqual([isCheck(note(undefined)), isCheck(note({ checkFile: 'x' }))], [false, false])
})

test('textHash: twelve hex characters, changed by the text and by the id', () => {
  const q = questionOf('q1', 'how')
  assert.match(textHash(q), /^[0-9a-f]{12}$/)
  assert.notEqual(textHash(q), textHash({ ...q, text: 'Other?' }))
  assert.notEqual(textHash(q), textHash({ ...q, id: 'q2' }))
})

test('sameQuestion: by the hash the thread was made with; an older thread by its first message', () => {
  const q = questionOf('q1', 'how')
  assert.ok(sameQuestion(note({ check: { file: 'f', q: 'q1', h: textHash(q) } }), q))
  assert.ok(!sameQuestion(note({ check: { file: 'f', q: 'q1', h: textHash(q) } }), { ...q, text: 'Other?' }))
  assert.ok(sameQuestion(note({ check: { file: 'f', q: 'q1' } }, 'Question q1?'), q))
})
