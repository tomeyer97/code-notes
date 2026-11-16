import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Status, checkPhase, checkPrompt, checkView, gradeBody, questionBody, statusText } from '../src/checkModel'

const bash = (command: string) => ({ name: 'Bash', input: { command } })
const q = (id: string, kind: 'how' | 'why' | 'failure', attempts: { answer: string }[] = []) => ({ id, kind, text: `Question ${id}?`, file: 'api/orders.js', start: 10, end: 12, attempts })
const st = (over: Partial<Status> = {}): Status => ({
  branch: 'feat/x', file: 'understanding/feat-x.json', changed: 120, small: false, exists: true, next: 'Answer 1 more question.',
  check: { version: 1, branch: 'feat/x', head: 'abcdef1', questions: [q('q1', 'failure'), q('q2', 'why'), { ...q('q3', 'how'), target: 'file' as const }] },
  summary: { total: 3, passed: 2, explained: 0, retry: 0, todo: 1, ungraded: 0, open: 1, needed: 2, met: true, states: ['pass', 'pass', 'todo'] },
  drift: { lines: 0, approx: false }, dirty: true, ...over,
})

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

test('thread messages: the question, a pass, a miss with its hint, an explanation', () => {
  assert.equal(questionBody(q('q1', 'failure') as never), 'Question q1?')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Not quite: what then?', hint: '' }), 'Not quite: what then?')
  assert.equal(gradeBody({ answer: 'a', verdict: 'pass', feedback: 'Yes, and the key makes it safe.' }), '✓ Yes, and the key makes it safe.')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Look at report().' }), 'Not quite. Close.\n\n**Hint:** Look at report().')
  assert.match(gradeBody({ answer: 'a', verdict: 'explained', feedback: 'It keeps it in a file.' }), /^It keeps it in a file\.\n\n_Counted as missed/)
})

test('the panel: rows with their state, progress, one next step', () => {
  let v = checkView(st(), { maxDrift: 40, staged: false })!
  assert.deepEqual(v.rows.map((r) => [r.n, r.state, r.word, r.where]), [[1, 'pass', '✓', 'api/orders.js:10'], [2, 'pass', '✓', 'api/orders.js:10'], [3, 'todo', 'to answer', 'api/orders.js']])
  assert.equal(v.progress, '2 of 3 passed · 2 needed')
  assert.equal(v.next, undefined, 'not all answered yet: no commit step')
  const done = st({ summary: { total: 3, passed: 2, explained: 1, retry: 0, todo: 0, ungraded: 0, open: 0, needed: 2, met: true, states: ['pass', 'pass', 'explained'] } })
  v = checkView(done, { maxDrift: 40, staged: false })!
  assert.equal(v.progress, 'Passed · 2 of 3')
  assert.deepEqual(v.next, { text: 'Commit understanding/feat-x.json and push.', action: 'stage', button: 'Stage it' })
  assert.deepEqual(checkView(done, { maxDrift: 40, staged: true })!.next, { text: 'Staged. Commit and push.' })
  assert.equal(checkView(st({ drift: { lines: 52, approx: false } }), { maxDrift: 40, staged: false })!.next!.action, 'topUp')
  assert.equal(checkView(st(), { maxDrift: 40, staged: false, grading: new Set(['q3']) })!.rows[2].word, 'checking…')
})

test('the status bar', () => {
  assert.equal(statusText(st({ exists: false, check: undefined, summary: undefined }), 40)!.text, '$(checklist) Check')
  assert.equal(statusText(st({ exists: false, small: true, check: undefined, summary: undefined }), 40), undefined)
  assert.equal(statusText(st(), 40)!.text, '$(checklist) 2/3 ✓')
  const done = st({ summary: { total: 3, passed: 3, explained: 0, retry: 0, todo: 0, ungraded: 0, open: 0, needed: 2, met: true, states: ['pass', 'pass', 'pass'] } })
  assert.equal(statusText(done, 40)!.text, '$(pass) 3/3 ✓')
  assert.equal(statusText(st({ drift: { lines: 90, approx: false } }), 40)!.text, '$(warning) 2/3 ✓')
})
