// Where Claude writing the check stands (src/check/writerState.ts): the questions' and the tour's state machines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuestionsState, TourStates, type CheckRun, type TourRun } from '../src/check/writerState'

const run = (branch = 'feat/a'): CheckRun => ({ started: 0, phase: 'starting', branch })
const failure = (branch = 'feat/a') => ({ branch, topUp: false, text: 'Claude is busy right now.' })

test('questions: one run at a time; in the foreground a failure is said, a success leaves nothing', () => {
  const q = new QuestionsState()
  const r = run()
  assert.equal(q.start(r), true)
  assert.equal(q.run, r)
  assert.equal(q.start(run()), false, 'one run at a time')
  q.ended()
  assert.equal(q.run, undefined)
  q.failed(failure(), false)
  assert.equal(q.failure?.text, 'Claude is busy right now.')
  q.clearFailure()
  assert.equal(q.failure, undefined)
  q.start(run())
  q.ended()
  q.wrote(3, false)
  assert.deepEqual(q.now, { kind: 'idle' })
})

test('questions: a background run keeps an earlier failure shown until it succeeds, then counts its questions', () => {
  const q = new QuestionsState()
  q.cantStart(failure())
  q.start(run())
  assert.equal(q.failure?.branch, 'feat/a', 'still shown while the background run works')
  q.ended()
  q.failed(failure('feat/b'), true)
  assert.equal(q.failure?.branch, 'feat/a', 'a background failure says nothing')
  q.start(run())
  q.ended()
  q.wrote(2, true)
  assert.equal(q.failure, undefined)
  assert.equal(q.ready, 2)
  // A foreground top-up meanwhile keeps the count; opening them clears it.
  q.start(run())
  assert.equal(q.ready, 2)
  q.ended()
  q.wrote(1, false)
  assert.equal(q.ready, 2)
  q.clearReady()
  assert.equal(q.ready, 0)
})

test('questions: a cancelled run, or one whose branch was switched, ends where it started', () => {
  const q = new QuestionsState()
  q.start(run())
  q.wrote(2, true)
  assert.equal(q.run !== undefined, true, 'what a run says goes to after it, not over it')
  q.ended()
  assert.equal(q.ready, 2)
})

test('tour: per branch; paused when its branch is left, resumed once back and the stopped run has ended', () => {
  const t = new TourStates()
  const a: TourRun = { ...run('feat/a'), session: 's1', topUp: false }
  assert.equal(t.start(a), true)
  assert.equal(t.start({ ...run('feat/b'), topUp: false }), false, 'one tour at a time')
  assert.equal(t.run, a)
  t.pause(a)
  assert.equal(t.run, undefined)
  assert.equal(t.of('feat/a').kind, 'paused')
  assert.equal(t.resume('feat/a'), undefined, 'not while the stopped run is still ending')
  assert.equal(t.ended(a), false, 'it was paused')
  assert.deepEqual(t.resume('feat/a'), { session: 's1', topUp: false })
  assert.equal(t.of('feat/a').kind, 'idle')
})

test('tour: a failure is kept for its branch, cleared when a tour of that branch starts', () => {
  const t = new TourStates()
  const a: TourRun = { ...run('feat/a'), topUp: false }
  t.start(a)
  assert.equal(t.ended(a), true)
  t.failed('feat/a')
  assert.equal(t.of('feat/a').kind, 'failed')
  assert.equal(t.of('feat/b').kind, 'idle')
  const b: TourRun = { ...run('feat/b'), topUp: false }
  t.start(b)
  assert.equal(t.of('feat/a').kind, 'failed', 'another branch\'s tour leaves it')
  t.ended(b)
  t.start({ ...a })
  assert.equal(t.of('feat/a').kind, 'writing')
})
