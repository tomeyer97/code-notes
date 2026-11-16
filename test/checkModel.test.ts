import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Status, Summary, Words, checkPhase, checkPrompt, checkView, concernOf, gradeBody, linksAt, questionBody, statusText, tourPrompt } from '../src/checkModel'

const bash = (command: string) => ({ name: 'Bash', input: { command } })
const q = (id: string, kind: 'how' | 'why' | 'failure', attempts: { answer: string }[] = []) => ({ id, kind, text: `Question ${id}?`, file: 'api/orders.js', start: 10, end: 12, attempts })
const sum = (states: Summary['states'], over: Partial<Summary> = {}): Summary => {
  const passed = states.filter((x) => x === 'pass' || x === 'restated').length, done = passed + states.filter((x) => x === 'explained').length
  return { total: states.length, passed, done, explained: 0, restated: 0, retry: 0, todo: 0, ungraded: 0, open: states.length - done, needed: 2, met: done === states.length && passed >= 2, states, ...over }
}
const st = (over: Partial<Status> = {}): Status => ({
  branch: 'feat/x', file: 'understanding/feat-x.json', changed: 120, exists: true, next: '',
  check: { version: 1, branch: 'feat/x', head: 'abcdef1', answeredBy: { name: 'Ada', email: 'ada@example.com' }, questions: [q('q1', 'failure'), { ...q('q2', 'why'), also: [{ file: 'worker/queue.js', start: 84, end: 96 }] }, { ...q('q3', 'how'), target: 'file' as const }] },
  summary: sum(['pass', 'pass', 'todo']), state: { phase: 'answering', done: 2, total: 3, passed: 2, needed: 2 },
  drift: { lines: 0, approx: false }, dirty: true, ...over,
})
const W = (over: Partial<Words> = {}): Words => ({ tone: 'todo', bar: 'Understanding 2/3', title: '2 of 3 done', line: 'Answer all 3 · 2 must pass.', rule: 'Answer all 3 · 2 must pass', ...over })

test('the prompt names the skill, the script and the base; a top-up asks for the new part only', () => {
  const p = checkPrompt({ skill: '/ext/skills/understanding-check', branch: 'feat/x', baseRef: 'origin/main', base: 'abc123', topUp: false, bundled: true })
  assert.match(p, /Read \/ext\/skills\/understanding-check\/SKILL\.md and follow it exactly/)
  assert.match(p, /questions\.mjs start --base abc123/)
  const t = checkPrompt({ skill: '/s', branch: 'feat/x', baseRef: 'origin/main', base: 'abc', topUp: true, bundled: false })
  assert.match(t, /Use the understanding-check skill to add 1-2 questions/); assert.match(t, /start --top-up/)
})

test('plain phases from the script\'s commands', () => {
  assert.equal(checkPhase(bash('/s/scripts/questions.mjs start --base x'), 'starting'), 'reading the change')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'reading the change'), 'reading the code')
  assert.equal(checkPhase(bash('/s/scripts/questions.mjs add --kind why'), 'reading the code'), 'writing questions')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'writing questions'), 'writing questions')
  assert.equal(checkPhase(bash('/s/scripts/questions.mjs finish'), 'writing questions'), 'checking')
})

test('thread messages: the question (with the code it also needs), a pass, a miss with its hint, an explanation, a restatement', () => {
  assert.equal(questionBody(q('q1', 'failure') as never), 'Question q1?')
  assert.equal(questionBody({ ...q('q1', 'failure'), also: [{ file: 'worker/queue.js', start: 84, end: 96 }] } as never), 'Question q1?\n\nAlso read: worker/queue.js:84-96')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Not quite: what then?', hint: '' }), 'Not quite: what then?')
  assert.equal(gradeBody({ answer: 'a', verdict: 'pass', feedback: 'Right. The key makes it safe.' }), '✓ Right. The key makes it safe.')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Look at report().' }), 'Not quite. Close.\n\n**Hint:** Look at report().')
  assert.equal(gradeBody({ answer: 'a', verdict: 'explained', feedback: 'It keeps it in a file.' }), 'It keeps it in a file.\n\n_Got it? Say it back in one sentence (optional)._')
  assert.equal(gradeBody({ answer: 'a', verdict: 'restated', feedback: 'Right.' }), '✓ Right.')
  assert.match(gradeBody({ answer: 'a', verdict: 'explained', feedback: 'The lock, not the lookup.' }, { restatement: true }), /^The lock, not the lookup\.\n\n_Try once more, or leave it: it is done\._$/)
})

test('the Check view: the CLI\'s words, rows with their state, one button', () => {
  let v = checkView(st(), W())
  assert.deepEqual([v.tone, v.title, v.line], ['todo', '2 of 3 done', 'Answer all 3 · 2 must pass.'])
  assert.deepEqual(v.rows.map((r) => [r.n, r.state, r.word, r.where, r.also]), [[1, 'pass', '', 'api/orders.js:10', []], [2, 'pass', '', 'api/orders.js:10', ['worker/queue.js:84-96']], [3, 'todo', '', 'api/orders.js', []]])
  assert.equal(v.action, undefined, 'answering: no button')
  assert.equal(checkView(st(), W(), { grading: new Set(['q3']) }).rows[2].word, 'checking…')
  const done = st({ summary: sum(['pass', 'pass', 'explained']), state: { phase: 'done', done: 3, total: 3, passed: 2, needed: 2 } })
  const ok = W({ tone: 'ok', title: '✓ Done', line: 'Commit and push.' })
  assert.deepEqual(checkView(done, ok).action, { id: 'commitPush', label: 'Commit & push' })
  assert.equal(checkView(done, ok).rows[2].word, 'explained · say it back')
  const clean = { ...done, dirty: false }
  assert.deepEqual([checkView(clean, ok, { unpushed: true }).line, checkView(clean, ok, { unpushed: true }).action?.id], ['Not pushed yet.', 'commitPush'])
  assert.deepEqual([checkView(clean, ok, { unpushed: false }).line, checkView(clean, ok, { unpushed: false }).action], ['Pushed.', undefined])
  assert.equal(checkView(clean, ok, { unpushed: true, pushed: 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.' }).line, 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.')
  assert.deepEqual(checkView(st({ state: { phase: 'drift', grew: 52, commitFirst: false } }), W({ tone: 'warn' })).action, { id: 'topUp', label: 'Add questions' })
  assert.deepEqual(checkView(st({ state: { phase: 'drift', grew: 52, commitFirst: true } }), W({ tone: 'warn' })).action, { id: 'scm', label: 'Commit…' })
  assert.deepEqual(checkView(st({ exists: false, check: undefined, summary: undefined, state: { phase: 'none', changed: 28 } }), W({ title: 'No check yet for feat/x', line: '28 code lines changed.' })).action, { id: 'start', label: 'Start' })
  assert.equal(checkView(done, ok, { busy: 'Pushing…' }).action, undefined)
  // Someone else's check: one line, nothing blocked.
  assert.equal(checkView(st(), W(), { me: { name: 'Bob', email: 'bob@example.com' } }).who, "Ada's check: your answers are recorded as yours.")
  assert.equal(checkView(st(), W(), { me: { name: 'Ada', email: 'ada@example.com' } }).who, undefined)
})

test('concerns: the grader\'s latest, else the question\'s own "may be a bug"; shown on the row', () => {
  const base = q('q1', 'failure')
  assert.equal(concernOf(base as never), undefined)
  assert.deepEqual(concernOf({ ...base, suspect: true } as never), { text: 'May be a bug: fix it or explain.', flagged: false, suspect: true })
  const c = { ...base, attempts: [{ answer: 'a', verdict: 'pass' as const, concern: 'OPS_EMAIL is never set: alerts go nowhere.' }], concern: { text: 'OPS_EMAIL is never set: alerts go nowhere.', flagged: true } }
  assert.deepEqual(concernOf(c as never), { text: 'OPS_EMAIL is never set: alerts go nowhere.', flagged: true, suspect: false })
  const v = checkView(st({ check: { ...st().check!, questions: [c as never, { ...base, id: 'q2', suspect: true } as never] }, summary: sum(['pass', 'todo']) }), W())
  assert.deepEqual(v.rows.map((r) => r.flag), ['flagged for review', 'may be a bug'])
  assert.equal(concernOf({ ...base, concern: { text: 'x', flagged: true, by: { name: 'Bob', email: 'bob@example.com' } } } as never)!.by, 'Bob')
})

test('the status bar: the CLI\'s words with an icon; amber for a top-up; hidden when no check is needed', () => {
  assert.deepEqual(statusText(st(), W()), { text: '$(checklist) Understanding 2/3', tip: '2 of 3 done · Answer all 3 · 2 must pass.', warn: false })
  assert.equal(statusText(st({ state: { phase: 'done' } }), W({ tone: 'ok', bar: '✓ Understanding', title: '✓ Done', line: 'Commit and push.' }))!.text, '$(pass) Understanding')
  assert.deepEqual(statusText(st({ state: { phase: 'drift', grew: 46 } }), W({ tone: 'warn', bar: 'Needs top-up: +46 lines' })), { text: '$(warning) Needs top-up: +46 lines', tip: '2 of 3 done · Answer all 3 · 2 must pass.', warn: true })
  assert.equal(statusText(st({ state: { phase: 'nothing' } }), W({ bar: '' })), undefined)
  assert.equal(statusText(undefined, W()), undefined)
})

test('code links: the question\'s on the first message, each grade\'s own after; a linked "also" range needs no line', () => {
  const ql = { phrase: 'the reset function', file: 'api/limits.js', start: 11, end: 13 }
  const gl = { phrase: 'the window check', file: 'api/limits.js', start: 6, end: 6 }
  const qq = { ...q('q1', 'failure'), links: [ql], also: [{ file: 'api/limits.js', start: 11, end: 13 }, { file: 'api/store.js', start: 2, end: 4 }],
    attempts: [{ answer: 'a', verdict: 'retry' as const, links: [gl] }, { answer: 'b' }] }
  const roles = ['agent', 'human', 'agent', 'human']
  assert.deepEqual(linksAt(qq as never, roles, 0), [ql])
  assert.deepEqual(linksAt(qq as never, roles, 1), [])
  assert.deepEqual(linksAt(qq as never, roles, 2), [gl])
  assert.deepEqual(linksAt(qq as never, roles, 3), [])
  assert.equal(questionBody(qq as never), 'Question q1?\n\nAlso read: api/store.js:2-4')
})

test('the tour: its prompt goes on in the questions\' session; phases; the view walks it, writes one, or says it is being written; rows say their step', () => {
  const p = tourPrompt({ skill: '/ext/skills/understanding-check', journeySkill: '/ext/skills/code-journey', topUp: false, bundled: true, resumed: true })
  assert.match(p, /^Now write the tour of this change/)
  assert.match(p, /section "The tour" of \/ext\/skills\/understanding-check\/SKILL\.md/)
  assert.match(p, /Start with: \/ext\/skills\/understanding-check\/scripts\/questions\.mjs tour$/m)
  assert.match(p, /\/ext\/skills\/code-journey\/scripts\/journey\.py/)
  assert.match(tourPrompt({ skill: '/s', journeySkill: '/j', topUp: true, bundled: false, resumed: false }), /^Write the tour[\s\S]*questions\.mjs tour --top-up/)
  assert.equal(checkPhase(bash('/s/scripts/questions.mjs tour'), 'starting'), 'writing the tour')
  assert.equal(checkPhase(bash('/j/scripts/journey.py step /r tour api …'), 'reading the code'), 'writing the tour')
  assert.equal(checkPhase({ name: 'Read', input: {} }, 'writing the tour'), 'writing the tour')
  assert.equal(checkPhase(bash('/s/scripts/questions.mjs tour-finish --steps q1=2'), 'writing the tour'), 'checking')
  // No tour yet: "Write a tour"; being written: one muted line; written: "Walk the tour · 6 steps"; rows say their step.
  assert.deepEqual(checkView(st(), W()).tour, { label: 'Write a tour', action: 'write' })
  assert.deepEqual(checkView(st(), W(), { tourBusy: 'Writing the tour · 1:02' }).tour, { label: 'Writing the tour · 1:02' })
  assert.equal(checkView(st(), W(), { busy: 'Writing questions · 0:10' }).tour, undefined)
  const s = st()
  s.check!.journey = { title: 'Refunds', steps: Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i + 1}`, file: 'api/orders.js', range: { start: i + 1, end: i + 1 } })) }
  s.check!.questions[0].step = 2; s.check!.questions[2].step = 6
  const v = checkView(s, W())
  assert.deepEqual(v.tour, { label: 'Walk the tour · 6 steps', action: 'walk' })
  assert.deepEqual(v.rows.map((r) => r.step), [2, undefined, 6])
  assert.equal(checkView(st({ state: { phase: 'none' }, check: undefined }), W()).tour, undefined)
})
