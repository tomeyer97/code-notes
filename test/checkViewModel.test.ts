// The Check view's model by part: the button and the command per phase (src/check/actions.ts), how a push went, the
// row flag's precedence, the answer box while it is graded, and the plain-object helpers it uses. The view as a whole
// is test/checkModel.test.ts's and the goldens' (test/cli/golden-understanding.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushOutcome, runAction, viewAction } from '../src/check/actions'
import { answerBox } from '../src/check/answerBox'
import { checkView } from '../src/check/viewModel'
import { ACTIONS, FLAG_WORD, LINE, TOUR } from '../src/check/checkWords'
import { definedOnly } from '../src/core/objects'
import { linkParts } from '../src/core/linkParts'
import type { BranchStatus, Phase, Question, Words } from '../src/check/types'

const question = (id: string, over: Partial<Question> = {}): Question => ({ id, kind: 'how', text: `Question ${id}?`, file: 'api/orders.js', start: 3, end: 4, ...over })
const statusOf = (phase: Phase, over: Partial<BranchStatus> = {}): BranchStatus => ({
  branch: 'feat/x', file: 'understanding/feat-x.json', changed: 10, exists: true, next: '',
  check: { version: 1, branch: 'feat/x', head: 'abc', questions: [question('q1'), question('q2')] } as BranchStatus['check'],
  summary: { states: ['pass', 'todo'] } as BranchStatus['summary'],
  state: { phase }, ...over,
})
const words: Words = { tone: 'todo', bar: 'Understanding', title: 'Title', line: 'The CLI says.', rule: '' }

test('each phase: the view\'s button and the command\'s step, side by side', () => {
  const row = (p: Phase, over: Partial<BranchStatus> = {}) => {
    const st = statusOf(p, over)
    return [viewAction(st, 'line', {}).action?.id ?? '-', runAction(st, {})]
  }
  assert.deepEqual(row('stashed'), ['-', 'show'])
  assert.deepEqual(row('nothing'), ['-', 'show'])
  assert.deepEqual(row('none'), ['start', 'start'])
  assert.deepEqual(row('invalid'), ['openFile', 'openFile'])
  assert.deepEqual(row('invalid', { state: { phase: 'invalid', conflict: { line: 3, mergeable: true } } }), ['merge', 'openFile'])
  assert.deepEqual(row('drift'), ['topUp', 'topUp'])
  assert.deepEqual(row('drift', { state: { phase: 'drift', commitFirst: true } }), ['scm', 'scm'])
  assert.deepEqual(row('answering'), ['-', 'walk'])
  assert.deepEqual(row('short'), ['-', 'walk'])
  assert.deepEqual(row('done', { dirty: true }), ['commitPush', 'commitPush'])
  // A phase a newer CLI may add: no button, the command walks.
  assert.deepEqual(row('later' as Phase), ['-', 'walk'])
})

test('no check yet and nothing committed: Commit… with its own line; the command still starts', () => {
  const st = statusOf('none')
  assert.deepEqual(viewAction(st, 'line', { uncommitted: true }), { action: { id: 'scm', label: ACTIONS.scm }, line: LINE.commitFirst })
  assert.equal(runAction(st, {}), 'start')
})

test('a file that is not JSON: the line says where, unless it is a conflict', () => {
  const at = 'Line 3: expected double-quoted property name.'
  assert.equal(viewAction(statusOf('invalid'), 'line', { invalidAt: at }).line, at)
  const conflict = statusOf('invalid', { state: { phase: 'invalid', conflict: { line: 3, mergeable: false } } })
  assert.equal(viewAction(conflict, 'line', { invalidAt: at }).line, 'line')
})

test('done: a change of the tour alone is a reason for the button, not for the command', () => {
  const st = statusOf('done', { dirty: true })
  const tourOnly = { commit: { files: [], todos: [], include: new Set<string>(), tourOnly: true }, unpushed: false }
  assert.deepEqual(viewAction(st, 'line', tourOnly), { action: { id: 'commitPush', label: ACTIONS.commitPush }, line: LINE.tourOnly })
  assert.equal(runAction(st, tourOnly), 'walk')
})

test('how a push went: given by push.ts, else read from its line; rejected offers Pull', () => {
  assert.equal(pushOutcome({}), undefined)
  assert.equal(pushOutcome({ pushed: LINE.pushed }), 'pushed')
  assert.equal(pushOutcome({ pushed: 'Push rejected: origin has newer commits.' }), 'rejected')
  assert.equal(pushOutcome({ pushed: 'Committed; the push failed.' }), 'other')
  // A structured outcome wins over the words.
  assert.equal(pushOutcome({ pushed: 'Origin said no.', pushOutcome: 'rejected' }), 'rejected')
  const clean = statusOf('done', { dirty: false })
  const rejected = viewAction(clean, 'line', { unpushed: true, pushed: 'Origin said no.', pushOutcome: 'rejected' })
  assert.deepEqual(rejected, { action: { id: 'pull', label: ACTIONS.pull }, line: 'Origin said no.' })
  assert.deepEqual(viewAction(clean, 'line', { unpushed: false, pushed: LINE.pushed }), { action: undefined, line: LINE.pushed })
})

test('a row\'s flag: an applied fix beats "may be a bug", which beats "flagged for review"', () => {
  const graded = [{ answer: 'a', verdict: 'pass' as const }]
  const qs = [
    question('q1'),
    question('q2', { concern: { text: 'Hm.' } }),
    question('q3', { concern: { text: 'Hm.', flagged: true } }),
    question('q4', { suspect: true, attempts: graded, concern: { text: 'May be a bug.', flagged: true } }),
    question('q5', { suspect: true, attempts: graded, concern: { text: 'May be a bug.' } }),
  ]
  const st = statusOf('answering', { check: { version: 1, branch: 'feat/x', head: 'abc', questions: qs } as BranchStatus['check'], summary: undefined })
  const flags = (applied: string[]) => checkView(st, words, { commit: { files: [], todos: [], include: new Set(), applied } }).rows.map((r) => r.flag)
  assert.deepEqual(flags([]), [undefined, FLAG_WORD.concern, FLAG_WORD.flagged, FLAG_WORD.suspect, FLAG_WORD.suspect])
  assert.deepEqual(flags(['q1', 'q3', 'q5']), [undefined, FLAG_WORD.concern, FLAG_WORD.applied, FLAG_WORD.suspect, FLAG_WORD.applied])
})

test('the answer box while it is graded: "Checking…" and nothing of the last round', () => {
  const q = question('q1', { attempts: [{ answer: 'a', verdict: 'retry', feedback: 'Look again.' }], concern: { text: 'Hm.' } })
  const shown = answerBox(q, 1, 'retry', { error: 'Busy.', applied: true })
  assert.deepEqual([shown.grade?.pass, shown.error, shown.concern], [false, 'Busy.', { text: 'Hm.', flagged: false, applied: true }])
  assert.deepEqual(answerBox(q, 1, 'retry', { grading: true, error: 'Busy.' }), { id: 'q1', n: 1, open: true, draft: '', checking: true })
})

test('the tour: offered to write only once there are questions; none on purpose: nothing', () => {
  assert.deepEqual(checkView(statusOf('answering'), words).tour, { label: TOUR.write, action: 'write' })
  assert.deepEqual(checkView(statusOf('answering'), words, { tourFailed: true }).tour, { label: TOUR.failed, action: 'write' })
  assert.equal(checkView(statusOf('drift'), words).tour, undefined)
  const noTour = statusOf('answering')
  noTour.check = { ...noTour.check!, noTour: true }
  assert.equal(checkView(noTour, words).tour, undefined)
})

test('definedOnly: a copy without the undefined fields, the original left as it is', () => {
  const o = { a: 1, b: undefined, c: null, d: '' }
  assert.deepEqual(definedOnly(o), { a: 1, c: null, d: '' })
  assert.ok('b' in o)
  assert.deepEqual(Object.keys(definedOnly({ z: 1, y: undefined, x: 2 })), ['z', 'x'])
})

test('linkParts: at the same place, the first link wins; overlapping phrases are skipped', () => {
  assert.deepEqual(linkParts('the lock and the key', [{ phrase: 'the lock' }, { phrase: 'the' }, { phrase: 'lock and' }]), [
    { text: 'the lock', link: 0 }, { text: ' and the key' },
  ])
})
