// The check file (cli/understanding/checkFile.ts): its name from the branch; attempts, of which only the final answer
// stays.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { addAttempt, attemptHash, fileFor, pruneAttempts, slugOf } = await cliModule('checkFile')
const { hashProblems, validateCheck } = await cliModule('validate')
const { stateOf } = await cliModule('state')

test('the check file is named after the branch', () => {
  assert.equal(slugOf('feat/Discount codes!'), 'feat-discount-codes')
  assert.equal(fileFor('fix/a__b'), 'understanding/fix-a__b.json')
})

/** A check with one question, answered three times: a retry, an explanation (Ada's), then Bo's answer. */
function answeredThrice() {
  const q = { id: 'q1', kind: 'why', text: 'Why is this so here?', file: 'a.js', start: 1, end: 2 }
  const check = { version: 1, branch: 'b', head: 'abcdef1', answeredBy: { name: 'Ada' }, questions: [q] }
  const a1 = addAttempt(check, q, 'a wrong guess', { name: 'Ada' })
  Object.assign(a1, { verdict: 'retry', feedback: 'Re-check the loop.', hint: 'Look at a.js:2', gradedAt: 't1' })
  a1.hash = attemptHash(q, a1)
  const a2 = addAttempt(check, q, 'still wrong', { name: 'Ada' })
  Object.assign(a2, { verdict: 'explained', feedback: 'It retries.', topic: 'retries', note: 'It retries.' })
  a2.hash = attemptHash(q, a2)
  addAttempt(check, q, 'It retries until it works.', { name: 'Bo' })
  return { check, q }
}

test('only the final answer stays: earlier attempts lose their text and hash, keep the grader\'s words', () => {
  const { check, q } = answeredThrice()
  assert.deepEqual(q.attempts.map((a) => [a.answer, a.hash, a.verdict]), [[undefined, undefined, 'retry'], [undefined, undefined, 'explained'], ['It retries until it works.', undefined, undefined]])
  assert.deepEqual([q.attempts[0].feedback, q.attempts[0].hint, q.attempts[0].at !== undefined, q.attempts[1].topic, q.attempts[2].by], ['Re-check the loop.', 'Look at a.js:2', true, 'retries', { name: 'Bo' }])
  assert.ok(!JSON.stringify(check).includes('wrong'), 'no wrong guess in the file')
})

test('only the final answer stays: the last attempt\'s hash is what CI verifies', () => {
  const { check, q } = answeredThrice()
  const last = q.attempts[2]
  last.verdict = 'restated'
  last.hash = attemptHash(q, last)
  assert.deepEqual([validateCheck(check), hashProblems(check)], [[], []])
  assert.equal(stateOf(q), 'restated')
  last.answer = 'edited by hand'
  assert.deepEqual(hashProblems(check), ['q1 attempt 3'])
  // The last attempt must keep its answer.
  delete last.answer
  assert.match(validateCheck(check).join(), /attempt 3: "answer" must be a string/)
})

test('only the final answer stays: the older format (every attempt with its answer and hash) still validates', () => {
  const { check, q } = answeredThrice()
  const old = { ...check, questions: [{ ...q, attempts: [{ answer: 'x', verdict: 'retry', hash: 'nothash' }, { answer: 'y', verdict: 'pass' }] }] }
  old.questions[0].attempts[1].hash = attemptHash(old.questions[0], old.questions[0].attempts[1])
  // A bad hash on an earlier attempt is not checked.
  assert.deepEqual([validateCheck(old), hashProblems(old)], [[], []])
  assert.equal(pruneAttempts(old.questions[0]).attempts[0].answer, undefined)
})
