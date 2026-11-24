// A concern about the code (src/check/concernState.ts): whether it is shown, its actions, and the people in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concernOf, isConcernAction, isViewConcernAction, samePerson, settledConcern, SUSPECT, whoOf } from '../src/check/concernState'
import { asQuestion, questionOf } from './checkFixtures'

const base = questionOf('q1', 'failure')
const answered = { ...base, suspect: true, attempts: [{ answer: 'a', verdict: 'pass' as const }] }

test('no concern: nothing shown', () => assert.equal(concernOf(base), undefined))

test('a suspect question says nothing before it is graded (that would give the answer away)', () => {
  assert.equal(concernOf(asQuestion({ ...base, suspect: true })), undefined)
  assert.equal(concernOf(asQuestion({ ...base, suspect: true, attempts: [{ answer: 'a' }] })), undefined)
})

test('a suspect question, once graded: its own "may be a bug"', () => {
  assert.deepEqual(concernOf(asQuestion(answered)), { text: SUSPECT, flagged: false, suspect: true })
})

test('the grader\'s concern: its words, flagged as stored', () => {
  const text = 'OPS_EMAIL is never set: alerts go nowhere.'
  assert.deepEqual(concernOf(asQuestion({ ...base, concern: { text, flagged: true } })), { text, flagged: true, suspect: false })
})

test('a "may be a bug" flagged by an older version is still the question\'s own', () => {
  const old = { ...answered, concern: { text: 'May be a bug: fix it or explain.', flagged: true } }
  assert.equal(concernOf(asQuestion(old))?.suspect, true)
})

test('who flagged it: by name', () => {
  const c = { ...base, concern: { text: 'x', flagged: true, by: { name: 'Bob', email: 'bob@example.com' } } }
  assert.equal(concernOf(asQuestion(c))?.by, 'Bob')
})

test('dismissed or fixed: done with', () => {
  assert.equal(concernOf(asQuestion({ ...base, concern: { text: 'x', dismissed: { reason: 'r' } } })), undefined)
  assert.equal(concernOf(asQuestion({ ...base, concern: { text: 'x', fixed: {} } })), undefined)
})

test('settledConcern: dismissed with a reason, by whom and when, no longer flagged', () => {
  const s = settledConcern({ text: 'x', flagged: true }, 'x', { reason: 'fine' }, { name: 'A', email: '' }, 'T')
  assert.deepEqual(s, { text: 'x', flagged: false, dismissed: { reason: 'fine', by: { name: 'A' }, at: 'T' } })
})

test('settledConcern: a question\'s own "may be a bug" fixed, with no one known', () => {
  assert.deepEqual(settledConcern(undefined, 'Why?', { fixed: true }, undefined, 'T'), { text: 'Why?', flagged: false, fixed: { at: 'T' } })
})

test('the actions: the view sends four; the command also takes "fixed"', () => {
  assert.ok(['fix', 'todo', 'flag', 'dismiss'].every(isViewConcernAction))
  assert.ok(!isViewConcernAction('fixed') && isConcernAction('fixed'))
  assert.ok(!isConcernAction('delete') && !isConcernAction(undefined))
})

test('samePerson: the same email, or the same name when one has no email', () => {
  assert.ok(samePerson({ name: 'A', email: 'a@x' }, { name: 'B', email: 'a@x' }))
  assert.ok(!samePerson({ name: 'A', email: 'a@x' }, { name: 'A', email: 'b@x' }))
  assert.ok(samePerson({ name: 'A' }, { name: 'A', email: 'b@x' }))
})

test('whoOf drops an empty email', () => assert.deepEqual(whoOf({ name: 'A', email: '' }), { name: 'A' }))
