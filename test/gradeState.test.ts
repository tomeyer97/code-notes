// What each question is doing in grading (src/check/gradeState.ts): one record per question, and the race check
// before a verdict is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GradeStates, stillUngraded } from '../src/check/gradeState'
import type { Attempt } from '../src/check/types'

test('GradeStates: an answer taken, then graded; one at a time per question', () => {
  const s = new GradeStates<string>()
  assert.deepEqual(s.stateOf('q1'), {})
  assert.equal(s.startAnswering('q1'), true)
  assert.equal(s.startAnswering('q1'), false, 'a second Ctrl+Enter meanwhile is not a second answer')
  assert.equal(s.busy('q1'), true)
  assert.deepEqual(s.busyIds(), ['q1'])
  // The grade starts while the answer is still being taken: it goes on once taking it is over.
  s.startGrading('q1')
  s.endAnswering('q1')
  assert.equal(s.grading('q1'), true)
  assert.deepEqual([...s.runs()], [['q1', undefined]], 'about to grade: no run yet')
  s.running('q1', 'run-1')
  assert.deepEqual([...s.runs()], [['q1', 'run-1']])
  assert.equal(s.startAnswering('q1'), false, 'no answer is taken while one is graded')
  s.endGrading('q1')
  assert.deepEqual(s.stateOf('q1'), {})
  assert.deepEqual(s.busyIds(), [])
})

test('GradeStates: a failure is kept by question and shown in its thread, until the next grade starts', () => {
  const s = new GradeStates<string>()
  s.fail('q2', 'note-2', { message: 'overloaded' })
  assert.deepEqual(s.stateOf('q2'), { error: { message: 'overloaded' }, note: 'note-2' })
  assert.deepEqual([...s.errorsByNote()], [['note-2', { message: 'overloaded' }]])
  // Answering meanwhile keeps it shown; a new grade clears it.
  s.startAnswering('q2')
  assert.equal(s.errorsByNote().size, 1)
  s.startGrading('q2')
  assert.equal(s.errorsByNote().size, 0)
  s.endGrading('q2')
  s.endAnswering('q2')
  assert.deepEqual(s.stateOf('q2'), {})
  s.fail('q3', 'note-3', { message: 'x', kind: 'no-cli' })
  s.clearError('q3')
  assert.deepEqual(s.stateOf('q3'), {})
})

test('stillUngraded: the verdict goes only on the same answer, still the latest and still ungraded', () => {
  const graded: Attempt = { answer: 'because', at: 't' } as Attempt
  assert.equal(stillUngraded({ ...graded }, graded)?.answer, 'because')
  assert.equal(stillUngraded(undefined, graded), undefined, 'the question is gone')
  assert.equal(stillUngraded({ answer: 'another', at: 't2' } as Attempt, graded), undefined, 'answered again meanwhile')
  assert.equal(stillUngraded({ ...graded, verdict: 'pass' } as Attempt, graded), undefined, 'graded elsewhere meanwhile')
})
