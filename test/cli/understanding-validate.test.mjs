// What validate says about a check file (cli/understanding/validate.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { validateCheck } = await cliModule('validate')

/** A valid check with one question, changed by `x`. */
const check = (x = {}) => ({ version: 1, branch: 'b', head: 'abcdef1', questions: [{ id: 'q1', kind: 'why', text: 'Why is this so here?', file: 'a.js', start: 1, end: 2, ...x }] })

test('validate: a good file has no errors; a bad one says what is wrong, for each field', () => {
  assert.deepEqual(validateCheck(check()), [])
  const bad = {
    version: 2, branch: '', head: 'zz', answeredBy: { name: 3 },
    questions: [
      { id: 'x', kind: 'trivia', text: 'short', file: '../a', start: 0, end: 1, attempts: [{ answer: 1 }, { answer: 'a', verdict: 'great' }] },
      { id: 'q1', kind: 'how', text: 'A long enough question?', file: 'a', target: 'file' },
      { id: 'q1', kind: 'how', text: 'A long enough question?', file: 'a', target: 'file' },
    ],
  }
  const errs = validateCheck(bad).join('\n')
  for (const w of ['version', 'branch', 'head', 'answeredBy', 'look like q1', 'kind', 'too short', 'inside the repository', '1-based', '"answer"', '"verdict"', 'id used twice']) assert.ok(errs.includes(w), w)
})

test('validate: --also outside the repository', () => {
  assert.equal(validateCheck(check({ also: [{ file: '../x', start: 1, end: 1 }] })).length, 1)
})

test('validate: suspect and concern', () => {
  assert.deepEqual(validateCheck(check({ suspect: true, concern: { text: 'x is never released', flagged: true } })), [])
  assert.deepEqual(validateCheck(check({ concern: { text: 'y' } })), [])
  assert.match(validateCheck(check({ suspect: 'yes' })).join(), /"suspect" must be true or false/)
  assert.match(validateCheck(check({ concern: 'x' })).join(), /"concern" must be/)
  assert.match(validateCheck(check({ concern: { text: 'x', flagged: 'yes' } })).join(), /"concern" must be/)
})

test('validate: optional code links on questions and attempts, checked lightly', () => {
  const link = { phrase: 'the retry loop', file: 'w.js', start: 4, end: 9 }
  const c = (qx, ax) => check({ ...qx, attempts: [{ answer: 'x', ...ax }] })
  assert.deepEqual(validateCheck(c({ links: [link] }, { links: [link], extra: 1 })), [])
  assert.match(validateCheck(c({ links: [{ ...link, start: 0 }] })).join(), /"links" must be a list/)
  assert.match(validateCheck(c({}, { links: 'x' })).join(), /attempt 1: "links" must be a list/)
})
