// `understanding grade` and `next`, `flag`: grading with a backend (the fake grader as Claude Code, a fake Messages
// API), and without one (the reply given by the caller, as the extension and the skill do).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { hashProblems, readCheck, summarize, validateCheck } from '../../cli/understanding.mjs'
import { gitIn, repo } from './helpers/repos.mjs'
import { FAKE, graderLog, run, writeQuestions } from './helpers/cli.mjs'
import { fakeAnthropic } from './helpers/servers.mjs'
import { cliModule } from './helpers/source.mjs'

const { GRADER } = await cliModule('constants')
/** The fake grader as Claude Code: "GOOD" passes, a first miss is retried, a second one explained. */
const CLAUDE = { UNDERSTANDING_BACKEND: 'claude', UNDERSTANDING_CLAUDE: FAKE }
const grade = (d, f, question, answer, env = CLAUDE) => run(d, ['grade', f, '--question', question, '--answer', answer, '--write'], env)

test('grade with the claude backend: a pass', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const r = await grade(d, f, 'q1', 'GOOD: it is kept')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /✓ q1 pass/)
})

test('grade with the claude backend: a miss gets a retry with a hint, a second one the explanation; hashes written', async () => {
  const d = repo()
  const f = writeQuestions(d)
  assert.match((await grade(d, f, 'q2', 'no idea')).out, /q2 retry: Not quite[\s\S]*Hint: Look at what the reset function does/)
  assert.match((await grade(d, f, 'q2', 'still no idea')).out, /q2 explained: It retries/)
  const c = readCheck(f)
  assert.deepEqual(c.questions[1].attempts.map((a) => a.verdict), ['retry', 'explained'])
  assert.deepEqual(hashProblems(c), [])
})

test('grade with the claude backend: the result is written; a second person is recorded on their attempts only', async () => {
  const d = repo()
  const f = writeQuestions(d)
  await grade(d, f, 'q1', 'GOOD: it is kept')
  assert.equal(readCheck(f).result.passed, 1)
  gitIn(d, 'config', 'user.email', 'bo@example.com')
  gitIn(d, 'config', 'user.name', 'Bo')
  await grade(d, f, 'q3', 'GOOD')
  const c = readCheck(f)
  assert.deepEqual(c.questions[2].attempts[0].by, { name: 'Bo', email: 'bo@example.com' })
  assert.equal(c.questions[0].attempts[0].by, undefined)
  assert.equal(validateCheck(c).length, 0)
})

test('grade with nothing left to grade says so', async () => {
  const d = repo()
  const f = writeQuestions(d)
  assert.match((await run(d, ['grade', f], CLAUDE)).out, /Nothing to grade/)
})

test('grade --answer keeps only the final answer', async () => {
  const d = repo()
  const f = writeQuestions(d)
  await grade(d, f, 'q2', 'no idea')
  await grade(d, f, 'q2', 'GOOD: now I see')
  const c = readCheck(f)
  assert.deepEqual(c.questions[1].attempts.map((a) => a.answer), [undefined, 'GOOD: now I see'])
  assert.deepEqual([validateCheck(c), hashProblems(c)], [[], []])
})

test('grade with the anthropic backend (Messages API): the key, the default model, the answer in the prompt', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const api = await fakeAnthropic('{"verdict":"pass","feedback":"Yes.","hint":""}')
  try {
    const r = await run(d, ['grade', f, '--question', 'q1', '--answer', 'kept in a file', '--backend', 'anthropic', '--write'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: api.url })
    assert.equal(r.code, 0, r.out)
    const [call] = api.calls
    assert.equal(call.path, '/v1/messages')
    assert.equal(call.headers['x-api-key'], 'k')
    assert.equal(call.body.model, GRADER.model)
    assert.match(call.body.messages[0].content, /kept in a file/)
    assert.equal(readCheck(f).questions[0].attempts[0].verdict, 'pass')
  } finally { api.close() }
})

// Without VS Code: the caller grades (the skill's agent, or the extension) and gives the CLI the reply. A bad grader
// path and no API key: any model call would fail loudly, and the fake grader would write its log.

const REPLY = {
  retry: '{"verdict":"retry","feedback":"Re-check what load does.","hint":"What does load() do with errors?"}',
  explained: [
    '```json',
    '{"verdict":"retry","feedback":"load() throws and nothing catches it, so main stops.","hint":"x","topic":"errors in load","concern":"A failing load() stops main: every later step is skipped."}',
    '```',
  ].join('\n'),
  pass: '{"verdict":"pass","feedback":"Right."}',
}
/** The grades that bring a check to each state, in order: [state, question, answer, reply]. */
const GRADES = [
  ['q1 retried', 'q1', 'It stops main.', REPLY.retry],
  ['q1 explained', 'q1', 'No idea.', REPLY.explained],
  ['q1 restated', 'q1', 'Nothing catches a throw from load, so main ends there.', REPLY.pass],
  ['q2 passed', 'q2', 'One at a time, in order.', REPLY.pass],
  ['all passed', 'q3', 'One at a time, in order.', REPLY.pass],
]
const gradeWith = (d, env, question, answer, reply) => run(d, ['grade', '--question', question, '--answer', answer, '--reply', reply], env)

/** repo()'s check written, then graded with replies up to `state` ('written' or one of GRADES): { d, f, env }. */
async function checkAt(state) {
  const d = repo()
  const f = writeQuestions(d)
  const env = { UNDERSTANDING_CLAUDE: FAKE, FAKE_GRADER_LOG: graderLog(d), ANTHROPIC_API_KEY: '' }
  for (const [at, question, answer, reply] of GRADES) {
    if (state === 'written') break
    assert.equal((await gradeWith(d, env, question, answer, reply)).code, 0)
    if (at === state) break
  }
  return { d, f, env }
}
const noModelCall = (d) => assert.ok(!fs.existsSync(graderLog(d)), 'no grader was ever run')

test('next: the first open question, where it is', async () => {
  const { d, env } = await checkAt('written')
  assert.equal((await run(d, ['next'], env)).out, 'q1 (1 of 3) · failure · src/app.js:3-6\nWhat happens when load() throws for one of the steps here?')
  noModelCall(d)
})

test('grade --prompt: the grader\'s instructions for this answer, nothing recorded', async () => {
  const { d, f, env } = await checkAt('written')
  const r = await run(d, ['grade', '--question', 'q1', '--answer', 'It stops main.', '--prompt'], env)
  assert.equal(r.code, 0)
  assert.match(r.out, /^You grade one answer in an "understanding check"/)
  assert.match(r.out, /<answer>\nIt stops main\.\n<\/answer>/)
  assert.match(r.out, /"verdict": "pass" \| "retry"/)
  assert.equal(readCheck(f).questions[0].attempts, undefined, '--prompt records nothing')
  noModelCall(d)
})

test('grade --reply, a miss: retry with the hint; next says "try 2" and shows the hint', async () => {
  const { d, env } = await checkAt('written')
  const r = await gradeWith(d, env, 'q1', 'It stops main.', REPLY.retry)
  assert.equal(r.out, '↻ q1 retry: Re-check what load does.\n  Hint: What does load() do with errors?\n0 of 3 done · next: q1')
  assert.match((await run(d, ['next'], env)).out, /^q1 \(1 of 3, try 2\)[\s\S]*\nHint: What does load\(\) do with errors\?$/)
  noModelCall(d)
})

test('grade --reply, a second miss: explained (the attempt fixes the verdict), its concern recorded unflagged', async () => {
  const { d, f, env } = await checkAt('q1 retried')
  const r = await gradeWith(d, env, 'q1', 'No idea.', REPLY.explained)
  assert.match(r.out, /^· q1 explained: load\(\) throws and nothing catches it, so main stops\.\n {2}Concern: A failing load\(\) stops main/)
  const c = readCheck(f)
  const q1 = c.questions[0]
  assert.deepEqual(q1.attempts.map((a) => [a.verdict, a.answer]), [['retry', undefined], ['explained', 'No idea.']], 'only the final answer is kept')
  assert.deepEqual([hashProblems(c), validateCheck(c)], [[], []])
  assert.deepEqual([q1.concern.text, q1.concern.flagged], ['A failing load() stops main: every later step is skipped.', false])
  noModelCall(d)
})

test('grade --reply after an explanation: said back in one sentence is restated (counts as passed)', async () => {
  const { d, env } = await checkAt('q1 explained')
  const r = await gradeWith(d, env, 'q1', 'Nothing catches a throw from load, so main ends there.', REPLY.pass)
  assert.match(r.out, /^✓ q1 restated: Right\./)
  noModelCall(d)
})

test('flag: the concern goes to the reviewer; a question without one says so', async () => {
  const { d, f, env } = await checkAt('q1 restated')
  assert.equal((await run(d, ['flag', '--question', 'q1'], env)).out, '⚠ Flagged for the reviewer: A failing load() stops main: every later step is skipped.')
  assert.equal(readCheck(f).questions[0].concern.flagged, true)
  assert.equal((await run(d, ['flag', '--question', 'q2'], env)).out, 'q2 has no concern to flag.')
  noModelCall(d)
})

test('all graded: the result is written, next says what to do (commit)', async () => {
  const { d, f, env } = await checkAt('all passed')
  const c = readCheck(f)
  assert.deepEqual([c.result.verdict, summarize(c).met], ['pass', true])
  assert.match((await run(d, ['next'], env)).out, /^✓ Done: 3 of 3 passed \(2 needed\)\. Commit and push: node \S*understanding\.mjs commit$/)
  noModelCall(d)
})

test('grade --reply that is not a verdict: refused, nothing recorded', async () => {
  const { d, f, env } = await checkAt('all passed')
  const before = fs.readFileSync(f, 'utf8')
  const r = await gradeWith(d, env, 'q2', 'x', 'not json')
  assert.equal(r.code, 2)
  assert.match(r.out, /didn't reply with a verdict/)
  assert.equal(fs.readFileSync(f, 'utf8'), before)
  noModelCall(d)
})
