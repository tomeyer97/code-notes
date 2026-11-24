// The Check view's model (src/check/viewModel.ts): the view, its button, Commit & push's offer, the answer box, the
// tour's line, the status bar and the command's step. The view's words as a whole are in a golden
// (golden-check-view.test.ts); here each behaviour is one test, asserted on what it decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerBox, checkView, linkParts, runAction, statusText } from '../src/check/viewModel'
import type { QState } from '../src/check/types'
import { asQuestion, checkIn, questionOf, statusOf, wordsOf } from './checkFixtures'

/** Where a check stands with its questions in `states` (`phase` given). */
const statusIn = (states: [QState, QState, QState], over: Parameters<typeof statusOf>[0] = {}) => statusOf(over, checkIn(states))
/** Done: all 3 answered (one explained), with the CLI's words for it. */
const done = statusIn(['pass', 'pass', 'explained'], { state: { phase: 'done', done: 3, total: 3, passed: 2, needed: 2 } })
const ok = wordsOf({ tone: 'ok', title: '✓ Done', line: 'Commit and push.' })
/** Done and nothing left uncommitted. */
const clean = { ...done, dirty: false }
const nothingTicked = () => new Set<string>()

// ---------- the view ----------

test('the view says the CLI\'s words', () => {
  const v = checkView(statusOf(), wordsOf())
  assert.deepEqual([v.tone, v.title, v.line], ['todo', '2 of 3 done', 'Answer all 3 · 2 must pass.'])
})

test('a row per question: its state, where it is, the code it also reads', () => {
  const rows = checkView(statusOf(), wordsOf()).rows.map((r) => [r.n, r.state, r.where, r.also])
  assert.deepEqual(rows, [
    [1, 'pass', 'api/orders.js:10', []],
    [2, 'pass', 'api/orders.js:10', ['worker/queue.js:84-96']],
    [3, 'todo', 'api/orders.js', []],
  ])
})

test('a row being graded says so; an explained one asks to say it back', () => {
  assert.equal(checkView(statusOf(), wordsOf(), { grading: new Set(['q3']) }).rows[2].state, 'ungraded')
  assert.equal(checkView(done, ok).rows[2].state, 'explained')
  assert.notEqual(checkView(done, ok).rows[2].word, '')
})

test('someone else\'s check: one line, nothing blocked; one\'s own: none', () => {
  assert.match(checkView(statusOf(), wordsOf(), { me: { name: 'Bob', email: 'bob@example.com' } }).who ?? '', /^Ada's check/)
  assert.equal(checkView(statusOf(), wordsOf(), { me: { name: 'Ada', email: 'ada@example.com' } }).who, undefined)
})

test('a failed write is shown', () => assert.equal(checkView(statusOf(), wordsOf(), { failed: { text: 'x' } }).failed?.text, 'x'))

// ---------- its one button ----------

const noneStatus = statusOf({ exists: false, summary: undefined, state: { phase: 'none', changed: 28 } }, undefined)
for (const [name, view, id] of [
  ['answering: none', () => checkView(statusOf(), wordsOf()), undefined],
  ['done and uncommitted: Commit & push', () => checkView(done, ok), 'commitPush'],
  ['committed, not pushed: Commit & push', () => checkView(clean, ok, { unpushed: true }), 'commitPush'],
  ['pushed: none', () => checkView(clean, ok, { unpushed: false }), undefined],
  ['grown since (drift): Add questions', () => checkView(statusOf({ state: { phase: 'drift', grew: 52, commitFirst: false } }), wordsOf({ tone: 'warn' })), 'topUp'],
  ['grown and uncommitted: Commit…', () => checkView(statusOf({ state: { phase: 'drift', grew: 52, commitFirst: true } }), wordsOf({ tone: 'warn' })), 'scm'],
  ['no check yet: Start', () => checkView(noneStatus, wordsOf()), 'start'],
  ['busy: none', () => checkView(done, ok, { busy: 'Pushing…' }), undefined],
  ['a rejected push: Pull', () => checkView(clean, ok, { unpushed: true, pushed: 'Committed, but the push was rejected: origin has newer commits.' }), 'pull'],
] as const) {
  test(`the view's button: ${name}`, () => assert.equal(view().action?.id, id))
}

test('the button\'s labels', () => {
  assert.equal(checkView(done, ok).action?.label, 'Commit & push')
  assert.equal(checkView(statusOf({ state: { phase: 'drift', grew: 52, commitFirst: false } }), wordsOf()).action?.label, 'Add questions')
  assert.equal(checkView(noneStatus, wordsOf()).action?.label, 'Start')
})

test('done: the line says whether it is pushed; what the last push said wins', () => {
  assert.equal(checkView(clean, ok, { unpushed: true }).line, 'Not pushed yet.')
  assert.equal(checkView(clean, ok, { unpushed: false }).line, 'Pushed.')
  assert.equal(checkView(clean, ok, { unpushed: true, pushed: 'Rejected.' }).line, 'Rejected.')
})

// ---------- what Commit & push offers ----------

test('Commit & push names the files it commits', () => {
  const commit = { files: ['understanding/feat-x.json', '.gitattributes', '.ignore'], todos: [], include: nothingTicked() }
  assert.match(checkView(done, ok, { commit }).commits ?? '', /feat-x\.json, \.gitattributes, \.ignore/)
})

test('a TODO the check added is offered, not taken; ticked, it goes', () => {
  const commit = { files: ['understanding/feat-x.json'], todos: ['api/refunds.js'], include: nothingTicked() }
  assert.deepEqual(checkView(done, ok, { commit }).also?.map((a) => [a.file, a.on]), [['api/refunds.js', false]])
  assert.equal(checkView(done, ok, { commit: { ...commit, include: new Set(['api/refunds.js']) } }).also?.[0].on, true)
})

test('once committed: only a push, nothing named', () => {
  const pushOnly = checkView(clean, ok, { unpushed: true, commit: { files: ['understanding/feat-x.json'], todos: [], include: nothingTicked() } })
  assert.deepEqual([pushOnly.commits, pushOnly.action?.label], [undefined, 'Push'])
})

const fixed = { files: ['understanding/feat-x.json'], todos: [], include: nothingTicked(), fixes: ['api/refunds.js'], applied: ['q3'], exclude: nothingTicked() }

test('an applied fix: offered ticked; Commit & push stays though the check file is committed', () => {
  const fv = checkView(clean, ok, { unpushed: false, commit: fixed })
  assert.deepEqual([fv.action?.id, fv.also?.map((a) => [a.file, a.on])], ['commitPush', [['api/refunds.js', true]]])
  assert.equal(checkView(clean, ok, { unpushed: false, commit: { ...fixed, exclude: new Set(['api/refunds.js']) } }).also?.[0].on, false)
})

test('an applied fix is said on its question, and in its answer box', () => {
  const withConcern = statusIn(['pass', 'pass', 'pass'], { state: { phase: 'done' } })
  withConcern.check!.questions[2].concern = { text: 'NaN slips through.', flagged: false }
  assert.ok(checkView(withConcern, ok, { commit: fixed }).rows[2].flag)
  assert.equal(checkView(withConcern, ok, { commit: fixed, selected: 'q3' }).answer?.concern?.applied, true)
})

test('only the tour is new: the button stays, the line and the files say so', () => {
  const tourOnly = { files: ['understanding/feat-x.json'], todos: [], include: nothingTicked(), tourOnly: true }
  const tv = checkView(done, ok, { unpushed: false, commit: tourOnly })
  assert.equal(tv.action?.id, 'commitPush')
  assert.match(tv.commits ?? '', /\(the tour\)/)
})

test('the first check also folds check files in diffs: said with the files, nothing on a push alone', () => {
  const fold = { files: ['understanding/feat-x.json'], todos: [], include: nothingTicked(), fold: true, foldText: 'FOLDS' }
  assert.match(checkView(done, ok, { commit: fold }).commits ?? '', /FOLDS$/)
  assert.equal(checkView(clean, ok, { unpushed: true, commit: fold }).commits, undefined)
  assert.ok(!('setup' in checkView(done, ok, { commit: fold })), 'no separate setup offer')
})

// ---------- concerns on the rows ----------

test('a row shows its question\'s concern: flagged, its own "may be a bug", or none', () => {
  const base = questionOf('q1', 'failure')
  const flagged = asQuestion({ ...base, attempts: [{ answer: 'a', verdict: 'pass' }], concern: { text: 'OPS_EMAIL is never set.', flagged: true } })
  const suspect = asQuestion({ ...base, id: 'q2', suspect: true, attempts: [{ answer: 'a', verdict: 'pass' }] })
  const unanswered = asQuestion({ ...base, id: 'q3', suspect: true })
  const check = { ...checkIn(), questions: [flagged, suspect, unanswered] }
  const flags = checkView(statusOf({}, check), wordsOf()).rows.map((r) => r.flag)
  assert.ok(flags[0] && flags[1] && flags[0] !== flags[1], JSON.stringify(flags))
  assert.equal(flags[2], undefined)
})

// ---------- the tour ----------

test('no tour yet: write one; being written: its clock; while the questions are written: nothing', () => {
  assert.equal(checkView(statusOf(), wordsOf()).tour?.action, 'write')
  assert.deepEqual(checkView(statusOf(), wordsOf(), { tourBusy: 'Writing the tour · 1:02' }).tour, { label: 'Writing the tour · 1:02' })
  assert.equal(checkView(statusOf(), wordsOf(), { busy: 'Writing questions · 0:10' }).tour, undefined)
  assert.equal(checkView(statusOf({ state: { phase: 'none' } }, undefined), wordsOf()).tour, undefined)
})

test('a written tour is walked; the rows say their step', () => {
  const s = statusOf()
  s.check!.journey = { title: 'Refunds', steps: Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i + 1}`, file: 'api/orders.js', range: { start: i + 1, end: i + 1 } })) }
  s.check!.questions[0].step = 2; s.check!.questions[2].step = 6
  const v = checkView(s, wordsOf())
  assert.equal(v.tour?.action, 'walk')
  assert.match(v.tour?.label ?? '', /6 steps/)
  assert.deepEqual(v.rows.map((r) => r.step), [2, undefined, 6])
})

test('documentation that describes no code: no tour, and nothing offers to write one', () => {
  const noTour = statusIn(['pass', 'pass', 'pass'], { state: { phase: 'done' } })
  noTour.check!.noTour = true
  assert.equal(checkView(noTour, ok).tour, undefined)
})

// ---------- the answer box ----------

test('linkParts: a grade\'s words with its code links', () => {
  assert.deepEqual(linkParts('Look at the reset function and reset.', [{ phrase: 'the reset function' }, { phrase: 'nowhere' }]), [{ text: 'Look at ' }, { text: 'the reset function', link: 0 }, { text: ' and reset.' }])
  assert.deepEqual(linkParts('plain'), [{ text: 'plain' }])
})

test('the answer box of a question to do: open, with its draft', () => {
  assert.deepEqual(answerBox(questionOf('q1', 'failure'), 1, 'todo', { draft: 'half an answer' }), { id: 'q1', n: 1, open: true, draft: 'half an answer' })
})

test('the answer box after a retry: open, the grade not a pass, its hint with code links', () => {
  const miss = asQuestion({ ...questionOf('q1', 'failure'), attempts: [{ answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Read the loop.', links: [{ phrase: 'the loop', file: 'a.js', start: 1, end: 2 }] }] })
  const b = answerBox(miss, 1, 'retry')
  assert.equal(b.open, true)
  assert.equal(b.grade?.pass, false)
  assert.deepEqual(b.grade?.hint?.find((p) => p.link !== undefined), { text: 'the loop', link: 0 })
  assert.equal(answerBox(miss, 1, 'ungraded', { grading: true }).checking, true)
})

test('the answer box once passed: closed, Next question while another is open', () => {
  const passed = asQuestion({ ...questionOf('q1', 'failure'), attempts: [{ answer: 'a', verdict: 'pass', feedback: 'Right.' }] })
  const b = answerBox(passed, 1, 'pass', { others: true })
  assert.deepEqual([b.open, b.grade?.pass, b.next], [false, true, true])
  assert.equal(answerBox(passed, 1, 'pass', { others: false }).next, undefined)
  // A concern stays in view with its actions, also after the box closes.
  assert.deepEqual(answerBox(asQuestion({ ...passed, concern: { text: 'Install fails.', flagged: false } }), 1, 'pass').concern, { text: 'Install fails.', flagged: false })
})

test('the answer box after an explanation: open, and it offers to say it back', () => {
  const ex = asQuestion({ ...questionOf('q1', 'failure'), attempts: [{ answer: 'a', verdict: 'explained', feedback: 'It retries.' }] })
  const b = answerBox(ex, 1, 'explained')
  assert.equal(b.open, true)
  assert.ok(b.grade?.say)
})

test('in the view, only the selected question has an answer box', () => {
  assert.equal(checkView(statusOf(), wordsOf()).answer, undefined)
  const v = checkView(statusOf(), wordsOf(), { selected: 'q3', draft: 'x' })
  assert.deepEqual([v.answer?.id, v.answer?.n, v.answer?.open, v.answer?.draft], ['q3', 3, true, 'x'])
  assert.equal(checkView(statusOf(), wordsOf(), { selected: 'q1' }).answer?.next, true, 'q1 passed, q3 open')
})

// ---------- the status bar ----------

test('the status bar: the CLI\'s words with an icon by state', () => {
  assert.deepEqual(statusText(statusOf(), wordsOf()), { text: '$(checklist) Understanding 2/3', tip: '2 of 3 done · Answer all 3 · 2 must pass.', warn: false })
  assert.equal(statusText(statusOf({ state: { phase: 'done' } }), wordsOf({ bar: '✓ Understanding' }))!.text, '$(pass) Understanding')
})

test('the status bar is amber for a top-up', () => {
  const t = statusText(statusOf({ state: { phase: 'drift', grew: 46 } }), wordsOf({ tone: 'warn', bar: 'Needs top-up: +46 lines' }))
  assert.deepEqual([t?.text, t?.warn], ['$(warning) Needs top-up: +46 lines', true])
})

test('the status bar is hidden when no check is needed', () => {
  assert.equal(statusText(statusOf({ state: { phase: 'nothing' } }), wordsOf({ bar: '' })), undefined)
  assert.equal(statusText(undefined, wordsOf()), undefined)
})

// ---------- the command ----------

for (const [name, st, o, step] of [
  ['an unreadable file: open it', statusOf({ state: { phase: 'invalid', conflict: { line: 3, mergeable: true } } }), {}, 'openFile'],
  ['no check: start', statusOf({ state: { phase: 'none' } }), {}, 'start'],
  ['drift, uncommitted: Source Control', statusOf({ state: { phase: 'drift', commitFirst: true } }), {}, 'scm'],
  ['drift: top up', statusOf({ state: { phase: 'drift' } }), {}, 'topUp'],
  ['done, only the tour new: walk it', statusOf({ state: { phase: 'done' }, dirty: true }), { commit: { tourOnly: true }, unpushed: false }, 'walk'],
  ['done, not pushed: Commit & push', statusOf({ state: { phase: 'done' }, dirty: false }), { unpushed: true }, 'commitPush'],
  ['answering: walk', statusOf(), {}, 'walk'],
] as const) {
  test(`the command does what the view offers: ${name}`, () => assert.equal(runAction(st, o), step))
}
