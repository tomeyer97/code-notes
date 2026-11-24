// A check file's text read as a check, the "only the tour is new" test, and a conflict's flags kept
// (src/check/checkText.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkOfText, keepFlags, keptBothLine, onlyTourChanged, sameExceptTour } from '../src/check/checkText'
import { checkIn } from './checkFixtures'
import type { Check } from '../src/check/types'

const tour = { title: 'Refunds', steps: [{ title: 'Step 1', file: 'api/orders.js', range: { start: 1, end: 1 } }] }
const valid = (): Check => ({ ...checkIn(), head: 'abcdef1234' })

test('checkOfText: a check, by the CLI\'s rules', () => {
  assert.equal(checkOfText(JSON.stringify(valid()))?.branch, 'feat/x')
})

test('checkOfText: not JSON, or JSON that is not a check', () => {
  assert.equal(checkOfText('{ "version": 1,, }'), undefined)
  assert.equal(checkOfText('{ "questions": [] }'), undefined)
})

test('sameExceptTour: the tour, the result and the time aside', () => {
  const a = valid(), b = { ...valid(), journey: tour, result: { done: 3, passed: 2, total: 3, needed: 2, verdict: 'pass' as const, at: 'T' } }
  assert.ok(sameExceptTour(a, b))
})

test('sameExceptTour: key order does not matter; an answer does', () => {
  const a = valid()
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as Check
  assert.ok(sameExceptTour(a, reordered))
  const answered = valid()
  answered.questions[2].attempts = [{ answer: 'new' }]
  assert.ok(!sameExceptTour(a, answered))
})

test('onlyTourChanged: a new tour and the same answers', () => {
  assert.ok(onlyTourChanged(valid(), { ...valid(), journey: tour }))
  assert.ok(!onlyTourChanged({ ...valid(), journey: tour }, { ...valid(), journey: tour }), 'the same tour: nothing new')
  assert.ok(!onlyTourChanged(valid(), valid()), 'no tour')
})

test('keepFlags: a concern flagged on either side stays flagged in the merge', () => {
  const merged = valid(), ours = valid(), theirs = valid()
  merged.questions[2].concern = { text: 'x', flagged: false, dismissed: { reason: 'fine' } }
  theirs.questions[2].concern = { text: 'x', flagged: true }
  assert.deepEqual(keepFlags(merged, [ours, theirs]), [3])
  assert.equal(merged.questions[2].concern?.flagged, true)
})

test('keepFlags: a side that does not read is no side', () => {
  assert.deepEqual(keepFlags(valid(), [undefined, valid()]), [])
})

test('keptBothLine: the questions whose flag was kept, named', () => {
  assert.match(keptBothLine([3]), /Question 3: its concern stays flagged/)
  assert.doesNotMatch(keptBothLine([]), /flagged/)
})
