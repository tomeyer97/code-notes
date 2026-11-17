import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { Status, Summary, Words, checkPhase, checkPrompt, checkView, concernOf, gradeBody, linksAt, questionBody, statusText, todoLines, todoPlace, gradeFailure, answerBox, linkParts, tourPrompt, writeFailure, commentMark, hunksOf, jsonErrorAt, missingMessages, runAction, samePerson, whoOf } from '../src/checkModel'
import { importCli } from '../src/importCli'

/** A Bash tool call, as the stream reports it. */
const bashCall = (command: string) => ({ name: 'Bash', input: { command } })
/** A question of the check on api/orders.js lines 10-12. */
const questionOf = (id: string, kind: 'how' | 'why' | 'failure', attempts: { answer: string }[] = []) => ({
  id,
  kind,
  text: `Question ${id}?`,
  file: 'api/orders.js',
  start: 10,
  end: 12,
  attempts,
})
/** The summary of questions in these states (2 must pass). */
const summaryOf = (states: Summary['states'], over: Partial<Summary> = {}): Summary => {
  const passed = states.filter((x) => x === 'pass' || x === 'restated').length
  const done = passed + states.filter((x) => x === 'explained').length
  return {
    total: states.length,
    passed,
    done,
    explained: 0,
    restated: 0,
    retry: 0,
    todo: 0,
    ungraded: 0,
    open: states.length - done,
    needed: 2,
    met: done === states.length && passed >= 2,
    states,
    ...over,
  }
}
/** A check on feat/x: three questions, two passed, one to do. */
const statusOf = (over: Partial<Status> = {}): Status => ({
  branch: 'feat/x',
  file: 'understanding/feat-x.json',
  changed: 120,
  exists: true,
  next: '',
  check: {
    version: 1,
    branch: 'feat/x',
    head: 'abcdef1',
    answeredBy: { name: 'Ada', email: 'ada@example.com' },
    questions: [
      questionOf('q1', 'failure'),
      { ...questionOf('q2', 'why'), also: [{ file: 'worker/queue.js', start: 84, end: 96 }] },
      { ...questionOf('q3', 'how'), target: 'file' as const },
    ],
  },
  summary: summaryOf(['pass', 'pass', 'todo']),
  state: { phase: 'answering', done: 2, total: 3, passed: 2, needed: 2 },
  drift: { lines: 0, approx: false },
  dirty: true,
  ...over,
})
/** What the status bar and the view say: answering, 2 of 3 done. */
const wordsOf = (over: Partial<Words> = {}): Words => ({
  tone: 'todo',
  bar: 'Understanding 2/3',
  title: '2 of 3 done',
  line: 'Answer all 3 · 2 must pass.',
  rule: 'Answer all 3 · 2 must pass',
  ...over,
})

test('the prompt names the skill, the script and the base; a top-up asks for the new part only', () => {
  const p = checkPrompt({ skill: '/ext/skills/understanding-check', branch: 'feat/x', baseRef: 'origin/main', base: 'abc123', topUp: false, bundled: true })
  assert.match(p, /Read \/ext\/skills\/understanding-check\/SKILL\.md and follow it exactly/)
  assert.match(p, /questions\.mjs start --base abc123/)
  const t = checkPrompt({ skill: '/s', branch: 'feat/x', baseRef: 'origin/main', base: 'abc', topUp: true, bundled: false })
  assert.match(t, /Use the understanding-check skill to add 1-2 questions/); assert.match(t, /start --top-up/)
})

test('plain phases from the script\'s commands', () => {
  assert.equal(checkPhase(bashCall('/s/scripts/questions.mjs start --base x'), 'starting'), 'reading the change')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'reading the change'), 'reading the code')
  assert.equal(checkPhase(bashCall('/s/scripts/questions.mjs add --kind why'), 'reading the code'), 'writing questions')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'writing questions'), 'writing questions')
  assert.equal(checkPhase(bashCall('/s/scripts/questions.mjs finish'), 'writing questions'), 'checking')
})

test('thread messages: the question (with the code it also needs), a pass, a miss with its hint, an explanation, a restatement', () => {
  assert.equal(questionBody(questionOf('q1', 'failure') as never), 'Question q1?')
  const withAlso = { ...questionOf('q1', 'failure'), also: [{ file: 'worker/queue.js', start: 84, end: 96 }, { file: 'worker/queue.js', start: 120, end: 124 }] }
  assert.equal(questionBody(withAlso as never), 'Question q1?\n\nAlso read: queue.js, queue.js (2)')
  // Named by file and linked to their lines: no line numbers in the text.
  assert.deepEqual(linksAt(withAlso as never, ['agent'], 0).map((l) => [l.phrase, l.start]), [['queue.js', 84], ['queue.js (2)', 120]])
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Not quite: what then?', hint: '' }), 'Not quite: what then?')
  assert.equal(gradeBody({ answer: 'a', verdict: 'pass', feedback: 'Right. The key makes it safe.' }), '✓ Right. The key makes it safe.')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Look at report().' }), 'Not quite. Close.\n\n**Hint:** Look at report().')
  assert.equal(gradeBody({ answer: 'a', verdict: 'explained', feedback: 'It keeps it in a file.' }), 'It keeps it in a file.\n\n_Got it? Say it back in one sentence (optional)._')
  assert.equal(gradeBody({ answer: 'a', verdict: 'restated', feedback: 'Right.' }), '✓ Right.')
  assert.match(gradeBody({ answer: 'a', verdict: 'explained', feedback: 'The lock, not the lookup.' }, { restatement: true }), /^The lock, not the lookup\.\n\n_Try once more, or leave it: it is done\._$/)
})

test('the Check view: the CLI\'s words, rows with their state, one button', () => {
  let v = checkView(statusOf(), wordsOf())
  assert.deepEqual([v.tone, v.title, v.line], ['todo', '2 of 3 done', 'Answer all 3 · 2 must pass.'])
  assert.deepEqual(v.rows.map((r) => [r.n, r.state, r.word, r.where, r.also]), [[1, 'pass', '', 'api/orders.js:10', []], [2, 'pass', '', 'api/orders.js:10', ['worker/queue.js:84-96']], [3, 'todo', '', 'api/orders.js', []]])
  assert.equal(v.action, undefined, 'answering: no button')
  assert.equal(checkView(statusOf(), wordsOf(), { grading: new Set(['q3']) }).rows[2].word, 'checking…')
  const done = statusOf({ summary: summaryOf(['pass', 'pass', 'explained']), state: { phase: 'done', done: 3, total: 3, passed: 2, needed: 2 } })
  const ok = wordsOf({ tone: 'ok', title: '✓ Done', line: 'Commit and push.' })
  assert.deepEqual(checkView(done, ok).action, { id: 'commitPush', label: 'Commit & push' })
  assert.equal(checkView(done, ok).rows[2].word, 'explained · say it back')
  const clean = { ...done, dirty: false }
  assert.deepEqual([checkView(clean, ok, { unpushed: true }).line, checkView(clean, ok, { unpushed: true }).action?.id], ['Not pushed yet.', 'commitPush'])
  assert.deepEqual([checkView(clean, ok, { unpushed: false }).line, checkView(clean, ok, { unpushed: false }).action], ['Pushed.', undefined])
  assert.equal(checkView(clean, ok, { unpushed: true, pushed: 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.' }).line, 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.')
  assert.deepEqual(checkView(statusOf({ state: { phase: 'drift', grew: 52, commitFirst: false } }), wordsOf({ tone: 'warn' })).action, { id: 'topUp', label: 'Add questions' })
  assert.deepEqual(checkView(statusOf({ state: { phase: 'drift', grew: 52, commitFirst: true } }), wordsOf({ tone: 'warn' })).action, { id: 'scm', label: 'Commit…' })
  assert.deepEqual(checkView(statusOf({ exists: false, check: undefined, summary: undefined, state: { phase: 'none', changed: 28 } }), wordsOf({ title: 'No check yet for feat/x', line: '28 code lines changed.' })).action, { id: 'start', label: 'Start' })
  assert.equal(checkView(done, ok, { busy: 'Pushing…' }).action, undefined)
  // Commit & push names what it commits; a TODO the check added is offered, not taken.
  const commit = { files: ['understanding/feat-x.json', '.gitattributes', '.ignore'], todos: ['api/refunds.js'], include: new Set<string>() }
  const cv = checkView(done, ok, { commit })
  assert.equal(cv.commits, 'Commits feat-x.json, .gitattributes, .ignore')
  assert.deepEqual(cv.also, [{ file: 'api/refunds.js', label: 'also refunds.js (TODO added)', on: false }])
  assert.equal(checkView(done, ok, { commit: { ...commit, include: new Set(['api/refunds.js']) } }).also?.[0].on, true)
  assert.equal(checkView(clean, ok, { unpushed: true, commit: { files: ['understanding/feat-x.json'], todos: [], include: new Set() } }).commits, undefined, 'nothing to commit: only the push')
  assert.equal(checkView(clean, ok, { unpushed: true, commit: { files: ['understanding/feat-x.json'], todos: [], include: new Set() } }).action?.label, 'Push')
  // An applied fix: offered ticked, named, said on its question; Commit & push stays even when the check file is committed.
  const fixed = { files: ['understanding/feat-x.json'], todos: [], include: new Set<string>(), fixes: ['api/refunds.js'], applied: ['q3'], exclude: new Set<string>() }
  const fv = checkView(clean, ok, { unpushed: false, commit: fixed })
  assert.deepEqual([fv.action?.label, fv.line, fv.also], ['Commit & push', 'Your fix is not committed yet.', [{ file: 'api/refunds.js', label: 'refunds.js (your fix)', on: true }]])
  assert.equal(checkView(clean, ok, { unpushed: false, commit: { ...fixed, exclude: new Set(['api/refunds.js']) } }).also?.[0].on, false)
  const withC = statusOf({ summary: summaryOf(['pass', 'pass', 'pass']), state: { phase: 'done' } })
  withC.check!.questions[2].concern = { text: 'NaN slips through.', flagged: false }
  assert.equal(checkView(withC, ok, { commit: fixed }).rows[2].flag, 'fix applied · not committed')
  assert.equal(checkView(withC, ok, { commit: fixed, selected: 'q3' }).answer?.concern?.applied, true)
  // Only the tour is new: said; the button stays, naming it.
  const tv = checkView(done, ok, { unpushed: false, commit: { files: ['understanding/feat-x.json'], todos: [], include: new Set(), tourOnly: true } })
  assert.deepEqual([tv.line, tv.action?.label, tv.commits], ['Only the tour is new: it can go with your next push.', 'Commit & push', 'Commits feat-x.json (the tour)'])
  // The repository's first check commit also folds check files in diffs: said on the Commit & push line, no other offer.
  const fold = { files: ['understanding/feat-x.json'], todos: [], include: new Set<string>(), fold: true, foldText: 'also folds check files in diffs (.gitattributes)' }
  assert.equal(checkView(done, ok, { commit: fold }).commits, 'Commits feat-x.json, also folds check files in diffs (.gitattributes)')
  assert.equal(checkView(clean, ok, { unpushed: true, commit: fold }).commits, undefined, 'only the push: nothing to fold')
  assert.ok(!('setup' in checkView(done, ok, { commit: fold })), 'no separate setup offer')
  // Documentation that describes no code: no tour, and nothing offers to write one.
  const noTour = statusOf({ summary: summaryOf(['pass', 'pass', 'pass']), state: { phase: 'done' } })
  assert.equal(checkView(noTour, ok).tour?.label, 'Write a tour')
  noTour.check!.noTour = true
  assert.equal(checkView(noTour, ok).tour, undefined)
  // Someone else's check: one line, nothing blocked.
  assert.equal(checkView(statusOf(), wordsOf(), { me: { name: 'Bob', email: 'bob@example.com' } }).who, "Ada's check: your answers are recorded as yours.")
  assert.equal(checkView(statusOf(), wordsOf(), { me: { name: 'Ada', email: 'ada@example.com' } }).who, undefined)
})

test('concerns: the grader\'s latest, else the question\'s own "may be a bug"; shown on the row', () => {
  const base = questionOf('q1', 'failure')
  assert.equal(concernOf(base as never), undefined)
  // A suspect question says nothing before it is answered (that would give the answer away).
  assert.equal(concernOf({ ...base, suspect: true } as never), undefined)
  const answered = { ...base, suspect: true, attempts: [{ answer: 'a', verdict: 'pass' as const }] }
  assert.deepEqual(concernOf(answered as never), { text: 'May be a bug.', flagged: false, suspect: true })
  assert.equal(concernOf({ ...base, suspect: true, attempts: [{ answer: 'a' }] } as never), undefined, 'not graded yet')
  const c = { ...base, attempts: [{ answer: 'a', verdict: 'pass' as const, concern: 'OPS_EMAIL is never set: alerts go nowhere.' }], concern: { text: 'OPS_EMAIL is never set: alerts go nowhere.', flagged: true } }
  assert.deepEqual(concernOf(c as never), { text: 'OPS_EMAIL is never set: alerts go nowhere.', flagged: true, suspect: false })
  const v = checkView(statusOf({ check: { ...statusOf().check!, questions: [c as never, { ...answered, id: 'q2' } as never, { ...base, id: 'q3', suspect: true } as never] }, summary: summaryOf(['pass', 'pass', 'todo']) }), wordsOf())
  assert.deepEqual(v.rows.map((r) => r.flag), ['flagged for review', 'may be a bug', undefined])
  assert.equal(concernOf({ ...base, concern: { text: 'x', flagged: true, by: { name: 'Bob', email: 'bob@example.com' } } } as never)!.by, 'Bob')
})

test('the status bar: the CLI\'s words with an icon; amber for a top-up; hidden when no check is needed', () => {
  assert.deepEqual(statusText(statusOf(), wordsOf()), { text: '$(checklist) Understanding 2/3', tip: '2 of 3 done · Answer all 3 · 2 must pass.', warn: false })
  assert.equal(statusText(statusOf({ state: { phase: 'done' } }), wordsOf({ tone: 'ok', bar: '✓ Understanding', title: '✓ Done', line: 'Commit and push.' }))!.text, '$(pass) Understanding')
  assert.deepEqual(statusText(statusOf({ state: { phase: 'drift', grew: 46 } }), wordsOf({ tone: 'warn', bar: 'Needs top-up: +46 lines' })), { text: '$(warning) Needs top-up: +46 lines', tip: '2 of 3 done · Answer all 3 · 2 must pass.', warn: true })
  assert.equal(statusText(statusOf({ state: { phase: 'nothing' } }), wordsOf({ bar: '' })), undefined)
  assert.equal(statusText(undefined, wordsOf()), undefined)
})

test('code links: the question\'s on the first message, each grade\'s own after; a linked "also" range needs no line', () => {
  const ql = { phrase: 'the reset function', file: 'api/limits.js', start: 11, end: 13 }
  const gl = { phrase: 'the window check', file: 'api/limits.js', start: 6, end: 6 }
  const qq = { ...questionOf('q1', 'failure'), links: [ql], also: [{ file: 'api/limits.js', start: 11, end: 13 }, { file: 'api/store.js', start: 2, end: 4 }],
    attempts: [{ answer: 'a', verdict: 'retry' as const, links: [gl] }, { answer: 'b' }] }
  const roles = ['agent', 'human', 'agent', 'human']
  assert.deepEqual(linksAt(qq as never, roles, 0), [ql, { phrase: 'store.js', file: 'api/store.js', start: 2, end: 4 }])
  assert.deepEqual(linksAt(qq as never, roles, 1), [])
  assert.deepEqual(linksAt(qq as never, roles, 2), [gl])
  assert.deepEqual(linksAt(qq as never, roles, 3), [])
  assert.equal(questionBody(qq as never), 'Question q1?\n\nAlso read: store.js')
})

test('a TODO from the check holds the whole concern (wrapped at words), above its line or inside the block it opens', () => {
  assert.deepEqual(todoLines(['//', ''], 'Stock goes up for damaged units.'), ['// TODO: Stock goes up for damaged units.'])
  const long = 'The stock update in the refund loop adds every refunded unit back to products with no restock option, so unreturned or damaged goods inflate stock.'
  const t = todoLines(['//', ''], long)
  assert.ok(t.length === 2 && t.every((l) => l.length <= 100), JSON.stringify(t))
  assert.equal(t.map((l, i) => (i ? l.replace(/^\/\/\s+/, '') : l.replace(/^\/\/ TODO: /, ''))).join(' '), long, 'nothing cut')
  assert.match(t[1], /^\/\/ {7}\S/, 'lined up under the text')
  const h = todoLines(['<!--', ' -->'], long)
  assert.ok(h[0].startsWith('<!-- TODO: ') && h.at(-1)!.endsWith(' -->') && !h[0].endsWith('-->'), JSON.stringify(h))
  const code = ['  try {', '    run()', '  } catch (err) {', '    log(err)', '  }']
  assert.deepEqual(todoPlace(code, 2), { line: 3, indent: '    ' }, 'a "} catch {" line: inside the catch block')
  assert.deepEqual(todoPlace(code, 1), { line: 1, indent: '    ' }, 'else above the line, at its indentation')
  assert.equal(gradeFailure('Claude Code exited (1): API Error: Connection error. (Overloaded) retrying failed'), 'Claude is busy right now; your answer is saved.')
  assert.equal(gradeFailure('couldn\'t start Claude Code (/x/claude): spawn /x/claude ENOENT'), "Claude Code wasn't found; your answer is saved.")
})

test('the answer box: only for the selected question; open until done; its grade with code links; Next question once done', () => {
  assert.deepEqual(linkParts('Look at the reset function and reset.', [{ phrase: 'the reset function' }, { phrase: 'nowhere' }]), [{ text: 'Look at ' }, { text: 'the reset function', link: 0 }, { text: ' and reset.' }])
  assert.deepEqual(linkParts('plain'), [{ text: 'plain' }])
  const base = questionOf('q1', 'failure')
  assert.deepEqual(answerBox(base as never, 1, 'todo', { draft: 'half an answer' }), { id: 'q1', n: 1, open: true, draft: 'half an answer' })
  const miss = { ...base, attempts: [{ answer: 'a', verdict: 'retry' as const, feedback: 'Close.', hint: 'Read the loop.', links: [{ phrase: 'the loop', file: 'a.js', start: 1, end: 2 }] }] }
  const b = answerBox(miss as never, 1, 'retry')
  assert.equal(b.open, true)
  assert.deepEqual(b.grade, { pass: false, feedback: [{ text: 'Not quite. Close.' }], hint: [{ text: 'Read ' }, { text: 'the loop', link: 0 }, { text: '.' }] })
  assert.equal(answerBox(miss as never, 1, 'ungraded', { grading: true }).checking, true)
  const passed = { ...base, attempts: [{ answer: 'a', verdict: 'pass' as const, feedback: 'Right.' }] }
  assert.deepEqual(answerBox(passed as never, 1, 'pass', { others: true }), { id: 'q1', n: 1, open: false, draft: '', grade: { pass: true, feedback: [{ text: 'Right.' }] }, next: true })
  assert.equal(answerBox(passed as never, 1, 'pass', { others: false }).next, undefined)
  // A concern stays in view with its actions, also after the box closes.
  assert.deepEqual(answerBox({ ...passed, concern: { text: 'Install fails.', flagged: false } } as never, 1, 'pass').concern, { text: 'Install fails.', flagged: false })
  const ex = { ...base, attempts: [{ answer: 'a', verdict: 'explained' as const, feedback: 'It retries.' }] }
  assert.deepEqual([answerBox(ex as never, 1, 'explained').open, answerBox(ex as never, 1, 'explained').grade?.say], [true, 'Got it? Say it back in one sentence (optional).'])
  // In the view: only the selected question has one.
  assert.equal(checkView(statusOf(), wordsOf()).answer, undefined)
  const v = checkView(statusOf(), wordsOf(), { selected: 'q3', draft: 'x' })
  assert.deepEqual([v.answer?.id, v.answer?.n, v.answer?.open, v.answer?.draft], ['q3', 3, true, 'x'])
  assert.equal(checkView(statusOf(), wordsOf(), { selected: 'q1' }).answer?.next, true, 'q1 passed, q3 open')
})

test('the tour: its prompt goes on in the questions\' session; phases; the view walks it, writes one, or says it is being written; rows say their step', () => {
  const p = tourPrompt({ skill: '/ext/skills/understanding-check', journeySkill: '/ext/skills/code-journey', topUp: false, bundled: true, resumed: true })
  assert.match(p, /^Now write the tour of this change/)
  assert.match(p, /section "The tour" of \/ext\/skills\/understanding-check\/SKILL\.md/)
  assert.match(p, /Start with: \/ext\/skills\/understanding-check\/scripts\/questions\.mjs tour$/m)
  assert.match(p, /\/ext\/skills\/code-journey\/scripts\/journey\.py/)
  assert.match(tourPrompt({ skill: '/s', journeySkill: '/j', topUp: true, bundled: false, resumed: false }), /^Write the tour[\s\S]*questions\.mjs tour --top-up/)
  assert.equal(checkPhase(bashCall('/s/scripts/questions.mjs tour'), 'starting'), 'writing the tour')
  assert.equal(checkPhase(bashCall('/j/scripts/journey.py step /r tour api …'), 'reading the code'), 'writing the tour')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'writing the tour'), 'writing the tour')
  assert.equal(checkPhase(bashCall('/s/scripts/questions.mjs tour-finish --steps q1=2'), 'writing the tour'), 'checking')
  // No tour yet: "Write a tour"; being written: one muted line; written: "Walk the tour · 6 steps"; rows say their step.
  assert.deepEqual(checkView(statusOf(), wordsOf()).tour, { label: 'Write a tour', action: 'write' })
  assert.deepEqual(checkView(statusOf(), wordsOf(), { tourBusy: 'Writing the tour · 1:02' }).tour, { label: 'Writing the tour · 1:02' })
  assert.equal(checkView(statusOf(), wordsOf(), { busy: 'Writing questions · 0:10' }).tour, undefined)
  const s = statusOf()
  s.check!.journey = { title: 'Refunds', steps: Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i + 1}`, file: 'api/orders.js', range: { start: i + 1, end: i + 1 } })) }
  s.check!.questions[0].step = 2; s.check!.questions[2].step = 6
  const v = checkView(s, wordsOf())
  assert.deepEqual(v.tour, { label: 'Walk the tour · 6 steps', action: 'walk' })
  assert.deepEqual(v.rows.map((r) => r.step), [2, undefined, 6])
  assert.equal(checkView(statusOf({ state: { phase: 'none' }, check: undefined }), wordsOf()).tour, undefined)
})

test('a failed write in plain words: never the CLI\'s own advice', () => {
  assert.deepEqual(writeFailure({ error: "There's an issue with the selected model (bogus). Run --model to pick a different model.", model: 'bogus' }), { text: 'Claude couldn\'t use the model "bogus".', setting: true })
  assert.deepEqual(writeFailure({ error: 'Error 529: overloaded' }), { text: 'Claude is busy right now.' })
  assert.equal(writeFailure({ error: 'The process exited. Run --verbose to see more.' }).text, "Claude couldn't write the questions: The process exited.")
  assert.equal(writeFailure({ text: 'I could not write any questions. `questions.mjs add` rejects every file I give it.' }).text, "Claude couldn't write questions for this change.")
  assert.deepEqual(writeFailure({ error: "couldn't start Claude Code (/home/a/.local/bin/claude): spawn /home/a/.local/bin/claude ENOENT" }), { text: "Claude Code wasn't found.", path: true })
  assert.equal(writeFailure({ text: 'UNCOMMITTED: this change is not committed yet' }).text, 'Commit your change first: questions are about committed code.')
  assert.equal(checkView(statusOf(), wordsOf(), { failed: { text: 'x' } }).failed?.text, 'x')
})

test('a failure the extension raised is said by its kind, whatever its words', () => {
  assert.deepEqual(writeFailure({ error: "couldn't start Claude Code (/x/claude): spawn /x/claude EACCES", errorKind: 'no-cli' }), { text: "Claude Code wasn't found.", path: true })
  assert.equal(gradeFailure('Claude Code was not found.', 'no-cli'), "Claude Code wasn't found; your answer is saved.")
  assert.equal(gradeFailure('Claude Code isn\'t logged in: 401'), "Claude Code isn't signed in; your answer is saved.")
  assert.equal(gradeFailure('something else'), "Claude couldn't check it; your answer is saved.")
})

test('every function of Cli is in the CLI', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/checkModel.ts'), 'utf8')
  const body = /export interface Cli \{([\s\S]*?)\n\}/.exec(src)![1]
  const names = [...body.matchAll(/^ {2}([A-Za-z_]\w*)[(:]/gm)].map((m) => m[1])
  assert.ok(names.length > 30, `found ${names.length} names`)
  const cli = await importCli<Record<string, unknown>>(path.join(__dirname, '../../cli/understanding.mjs'))
  assert.deepEqual(names.filter((n) => !(n in cli)), [])
})

test('the command does what the view offers, except where it says otherwise', () => {
  assert.equal(runAction(statusOf({ state: { phase: 'invalid', conflict: { line: 3, mergeable: true } } }), {}), 'openFile')
  assert.equal(runAction(statusOf({ state: { phase: 'none' } }), {}), 'start')
  assert.equal(runAction(statusOf({ state: { phase: 'drift', commitFirst: true } }), {}), 'scm')
  assert.equal(runAction(statusOf({ state: { phase: 'drift' } }), {}), 'topUp')
  assert.equal(runAction(statusOf({ state: { phase: 'done' }, dirty: true }), { commit: { tourOnly: true }, unpushed: false }), 'walk')
  assert.equal(runAction(statusOf({ state: { phase: 'done' }, dirty: false }), { unpushed: true }), 'commitPush')
  assert.equal(runAction(statusOf(), {}), 'walk')
})

test('people, comment marks, hunks, JSON errors, missing thread messages', () => {
  assert.ok(samePerson({ name: 'A', email: 'a@x' }, { name: 'B', email: 'a@x' }))
  assert.ok(!samePerson({ name: 'A', email: 'a@x' }, { name: 'A', email: 'b@x' }))
  assert.ok(samePerson({ name: 'A' }, { name: 'A', email: 'b@x' }))
  assert.deepEqual(whoOf({ name: 'A', email: '' }), { name: 'A' })
  assert.deepEqual([commentMark('a/b.py'), commentMark('x/Dockerfile'), commentMark('a.vue'), commentMark('a.ts')], [['#', ''], ['#', ''], ['<!--', ' -->'], ['//', '']])
  assert.deepEqual(hunksOf('diff\n@@ -1,2 +3,4 @@ x\n+a\n@@ -9 +12 @@\n@@ -20,3 +19,0 @@'), [{ start: 3, end: 6 }, { start: 12, end: 12 }, { start: 19, end: 19 }])
  assert.deepEqual(jsonErrorAt('Unexpected token \'}\', "{\n "a"}" is not valid JSON at position 4', '{\n "a"}'), { line: 2, col: 3, text: 'Line 2: unexpected token \'}\'.' })
  assert.equal(jsonErrorAt("Expected double-quoted property name in JSON at position 7 (line 2 column 3)", undefined)?.text, 'Line 2: expected double-quoted property name.')
  assert.equal(jsonErrorAt('ENOENT: no such file', undefined), undefined)
  const m = (role: string, body: string) => ({ role, body })
  assert.deepEqual(missingMessages([m('agent', 'Q'), m('human', 'a1'), m('human', 'remark')], [m('agent', 'Q'), m('human', 'a1'), m('agent', 'g1')]), [m('agent', 'g1')])
})
