// Where a check stands (cli/understanding/state.ts): each question's state, the summary and the pass rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { needed, ruleText, stateOf, summarize } = await cliModule('state')
const { DEFAULTS } = await cliModule('constants')

/** A question answered once per verdict given (undefined: answered, not graded). */
const q = (...vs) => ({ attempts: vs.map((v) => ({ answer: 'a', ...(v ? { verdict: v } : {}) })) })

test('needed: ceil(ratio × questions)', () => {
  assert.deepEqual([3, 4, 5].map((n) => needed(n, 0.6)), [2, 3, 3])
  assert.equal(needed(5, 1), 5)
})

test('a question\'s state is its last verdict', () => {
  assert.deepEqual([q(), q(undefined), q('retry'), q('retry', 'pass'), q('retry', 'explained'), q('retry', 'explained', 'restated')].map(stateOf),
    ['todo', 'ungraded', 'retry', 'pass', 'explained', 'restated'])
})

test('the summary: passed, needed, met, open and to do', () => {
  const s = summarize({ questions: [q('pass'), q('pass'), q('retry', 'explained'), q()] }, DEFAULTS)
  assert.deepEqual([s.passed, s.needed, s.met, s.open, s.todo], [2, 3, false, 1, 1])
})

test('the rule: every question done (pass, explained, restated; not "try again") and ceil(60 %) passed', () => {
  let s = summarize({ questions: [q('pass'), q('pass'), q('retry')] }, DEFAULTS)
  assert.deepEqual([s.done, s.passed, s.met], [2, 2, false])
  s = summarize({ questions: [q('pass'), q('retry', 'explained', 'restated'), q('retry', 'explained')] }, DEFAULTS)
  assert.deepEqual([s.done, s.passed, s.met], [3, 2, true])
  assert.equal(ruleText(s), 'Answer all 3 · 2 must pass')
})
