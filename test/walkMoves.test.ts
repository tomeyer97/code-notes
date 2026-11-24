// The walk's transitions that need no editor (src/tour/walkMoves.ts): resuming, Next past either end, a step removed
// mid-walk, and what a change of the journey file did to the step on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LoadedJourney } from '../src/journeys/steps'
import { classifyChange, numberOf, placeOf, resumeStep, samePlace, stepAfterRemoval, stepBy, stepCount, withoutPos } from '../src/tour/walkMoves'

/** A journey of steps with these ids, each on lines n*10..n*10+2 of a.ts (as written and as found). */
function journey(...ids: string[]): Pick<LoadedJourney, 'j' | 'at'> {
  const steps = ids.map((id, i) => ({ id, n: i + 1, title: id, file: 'a.ts', range: { start: (i + 1) * 10, end: (i + 1) * 10 + 2 } }))
  const at = steps.map((s) => ({ start: s.range.start, end: s.range.end, stale: false }))
  return { j: { steps } as unknown as LoadedJourney['j'], at }
}

test('numberOf: a step by id, 1-based; 0 when gone or no id', () => {
  const lj = journey('a', 'b', 'c')
  assert.equal(stepCount(lj), 3)
  assert.equal(numberOf(lj, 'b'), 2)
  assert.equal(numberOf(lj, 'x'), 0)
  assert.equal(numberOf(lj, undefined), 0)
})

test('resumeStep: never started is 0; the same step by id; else the same number, at most the last', () => {
  const lj = journey('a', 'b', 'c')
  assert.equal(resumeStep(lj, undefined), 0)
  assert.equal(resumeStep(lj, { step: 1, id: 'c', at: '' }), 3, 'by id: the step moved to 3')
  assert.equal(resumeStep(lj, { step: 2, id: 'gone', at: '' }), 2, 'its id is gone: the same number')
  assert.equal(resumeStep(lj, { step: 9, at: '' }), 3, 'past the end: the last')
})

test('withoutPos: only that journey starts over', () => {
  const pos = { a: { step: 1, at: '' }, b: { step: 2, at: '' } }
  assert.deepEqual(withoutPos(pos, 'a'), { b: { step: 2, at: '' } })
  assert.deepEqual(pos, { a: { step: 1, at: '' }, b: { step: 2, at: '' } }, 'not changed in place')
})

test('stepBy: Next past the last step finishes, Previous before the first says so', () => {
  assert.equal(stepBy(1, 1, 3), 2)
  assert.equal(stepBy(3, -1, 3), 2)
  assert.equal(stepBy(3, 1, 3), 'finish')
  assert.equal(stepBy(1, -1, 3), 'first')
})

test('stepAfterRemoval: the step now at its number, else the last; none left ends the walk', () => {
  assert.equal(stepAfterRemoval(2, 3), 2)
  assert.equal(stepAfterRemoval(3, 2), 2)
  assert.equal(stepAfterRemoval(1, 0), 0)
})

test('classifyChange: same, edited in place, moved with the journey as it was, rewritten elsewhere', () => {
  const lj = journey('a', 'b')
  const was = placeOf(lj, 2, 'a.ts')
  assert.deepEqual(was, { file: 'a.ts', start: 20, end: 22, removed: false, wrote: 'a.ts:20-22' })
  assert.equal(classifyChange(was, was), 'same')
  assert.equal(classifyChange(was, { ...was, wrote: 'a.ts:20-23' }), 'edited', 'the journey file changed, the code is where it was')
  assert.equal(classifyChange(was, { ...was, start: 25, end: 27 }), 'moved', 'the code moved; the journey file did not')
  assert.equal(classifyChange(was, { ...was, file: 'b.ts', wrote: 'b.ts:1-3' }), 'rewritten', 're-anchored by the journey file')
  assert.equal(classifyChange(was, { ...was, removed: true }), 'moved', 'its code removed: shown as it is now')
})

test('samePlace: file, lines and removed all count', () => {
  const p = { file: 'a.ts', start: 1, end: 2, removed: false, wrote: 'x' }
  assert.ok(samePlace(p, { ...p, wrote: 'y' }), 'what the journey file says is not the place')
  for (const d of [{ file: 'b.ts' }, { start: 0 }, { end: 3 }, { removed: true }]) assert.ok(!samePlace(p, { ...p, ...d }), JSON.stringify(d))
})
