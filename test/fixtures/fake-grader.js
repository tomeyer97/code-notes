#!/usr/bin/env node
// A stand-in for `claude -p` in the understanding check's tests. As the grader (json on stdin, or stream-json with the
// prompt after -p): passes an answer that says "GOOD", otherwise asks again (first try) or explains (later tries).
// Asked to write the questions or the tour: runs the skill's scripts as Claude would.
//
// Two inputs, nothing else:
// - The prompt, recognised by TASKS below. The prompts carry no task marker, so each entry names the prompt it
//   mirrors: a prompt reworded there needs its pattern here. A prompt no task matches is graded (the default).
// - The test's scenario: <git dir>/fake-grader.json, written by test/integration/check/fakeGrader.ts (see Scenario).
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
if (process.env.FAKE_GRADER_LOG) fs.appendFileSync(process.env.FAKE_GRADER_LOG, JSON.stringify(args) + '\n')
const fromArg = args[args.indexOf('-p') + 1]
const prompt = fromArg && !fromArg.startsWith('--') ? fromArg : fs.readFileSync(0, 'utf8')
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const tool = (command) => say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

// ---------- the scenario ----------

/**
 * @typedef {object} Scenario
 * @property {boolean} [writeError] writing the questions fails as with a model that doesn't exist
 * @property {'start' | 'tour'} [hold] wait at that point (before `start`; before the tour's journey) while it is set
 * @property {boolean} [noTour] the tour is not written (as when Claude gives up)
 */
let gitDirCache
const gitDir = () => (gitDirCache ??= path.resolve(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()))
/** Read each time: a held run waits for the test to change it. */
function scenario() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(path.join(gitDir(), 'fake-grader.json'), 'utf8')) } catch { /* none: the defaults */ }
  // The suite's entry (check/index.ts) still says "no tour" with this older marker file.
  if (s.noTour === undefined && fs.existsSync(path.join(gitDir(), 'fake-no-tour'))) s.noTour = true
  return s
}
/** A hold lasts at most this long, so a test that forgets to release it fails instead of hanging. */
const HOLD_MAX_MS = 8000
/** Waits at `point` while the scenario holds it; <git dir>/fake-grader-holding names the point meanwhile. */
function holdAt(point) {
  if (scenario().hold !== point) return
  const holding = path.join(gitDir(), 'fake-grader-holding')
  fs.writeFileSync(holding, point)
  const until = Date.now() + HOLD_MAX_MS
  while (scenario().hold === point && Date.now() < until) execFileSync('sleep', ['0.1'])
  fs.rmSync(holding, { force: true })
}

// ---------- the tasks ----------

/** Runs the skill's script as Claude would; a failure is kept in <git dir>/fake-errors.log for a failing test to read. */
function runScript(script, ...a) {
  tool(`${script} ${a.join(' ')}`)
  try { return execFileSync('node', [script, ...a], { encoding: 'utf8' }) } catch (e) {
    fs.appendFileSync(path.join(gitDir(), 'fake-errors.log'), `${a.join(' ')}\n${e.stdout ?? ''}${e.stderr ?? ''}\n`)
    throw e
  }
}

/** The questions for feat/limits (the suite's change, test/fixtures/check/limits.js). */
function limitsQuestions(script) {
  runScript(script, 'add', '--kind', 'failure', '--file', 'api/limits.js', '--lines', '4-7', '--text', 'What does allow() do for a customer whose window has already expired?')
  runScript(script, 'add', '--kind', 'why', '--file', 'api/limits.js', '--lines', '10-12', '--text', 'Why is the count kept per customer rather than per order here?')
  runScript(script, 'add', '--kind', 'edge', '--file', 'api/limits.js', '--whole-file', '--text', 'What happens to the counts when the API process restarts?')
}

/** Another branch stacked on feat/limits's check: as many questions as `start` asks for, about its changed file only. */
function stackedQuestions(script, began) {
  const want = Number(/WRITE: (\d+) question/.exec(began)[1])
  const file = /Files: (\S+) \(/.exec(began)[1]
  const kinds = ['failure', 'why', 'edge']
  const texts = ['What does this new part of the change add for a caller of this file?', 'Why is the new part of the change kept in this file instead of a new one?', 'What happens to existing callers once the new part of this change ships?']
  for (let k = 0; k < want; k++) runScript(script, 'add', '--kind', kinds[k], '--file', file, '--whole-file', '--text', texts[k])
}

function writeQuestions([, script, startArgs]) {
  say({ type: 'system', subtype: 'init' })
  // A test switches branches before Claude gets going (it can take seconds to start).
  holdAt('start')
  if (scenario().writeError) {
    say({ type: 'result', result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it. Run --model to pick a different model.", is_error: true })
    process.exit(1)
  }
  const began = runScript(script, 'start', ...startArgs.trim().split(/\s+/))
  // The branches the suite stacks on feat/limits (check/branches.ts, check/tour.ts), as `start` names them.
  if (/^CHANGE: branch feat\/(second|third) /m.test(began)) stackedQuestions(script, began)
  else limitsQuestions(script)
  runScript(script, 'finish')
  say({ type: 'result', result: 'q1 failure\nq2 why\nq3 edge', session_id: 'write-1', is_error: false })
}

/** "Suggest a fix" on a concern: one sentence and a suggestion block for the note's lines (a comment added on top). */
function suggestFix([, lines]) {
  const text = `Keep the counts somewhere that survives a restart.\n\n\`\`\`suggestion\n// FIXED: counts survive a restart\n${lines}\n\`\`\``
  say({ type: 'system', subtype: 'init' })
  say({ type: 'result', result: text, session_id: 'fix-1', is_error: false })
}

/** The tour of the feat/limits change, written with journey.py (JOURNEY_PY) as Claude would, then tour-finish. */
function writeTour([, script, topUp]) {
  const J = process.env.JOURNEY_PY
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  say({ type: 'system', subtype: 'init' })
  const out = execFileSync('node', [script, 'tour', ...(topUp ? ['--top-up'] : [])], { encoding: 'utf8' })
  tool(`${script} tour`)
  const dir = /--dir (\S+)/.exec(out)[1]
  const j = (a, input) => { tool(`${J} ${a[0]} …`); return execFileSync('python3', [J, ...a, '--dir', dir], { encoding: 'utf8', input: input ?? '' }) }
  if (scenario().noTour) { say({ type: 'result', result: 'PROBLEM: gave up', session_id: 'tour-1', is_error: false }); return }
  // A test switches branches while the tour is being written.
  holdAt('tour')
  j(['new', repo, 'tour', 'What happens when a customer orders too often?', 'Order limits'], 'The API counts each customer\'s orders per hour. The sixth order in an hour is refused.')
  j(['node', repo, 'tour', 'api', 'system', 'API', '--blurb', 'Takes orders and hands charge jobs to the worker'], 'The HTTP API.')
  j(['node', repo, 'tour', 'f_create', 'function', 'createOrder', 'api', 'api/orders.js:8-18'], 'Places an order.')
  j(['node', repo, 'tour', 'f_allow', 'function', 'allow', 'api', 'api/limits.js:4-8'], 'Counts orders per customer.')
  j(['node', repo, 'tour', 'f_reset', 'function', 'reset', 'api', 'api/limits.js:11-13'], 'Forgets a customer.')
  j(['node', repo, 'tour', 'f_insert', 'function', 'insertOrder', 'api', 'api/store.js:18-25'], 'Stores an order.')
  j(['node', repo, 'tour', 'f_push', 'function', 'push', 'api', 'api/queue.js:22-26'], 'Queues a job.')
  j(['edge', repo, 'tour', 'f_create', 'f_allow', 'checks the limit'])
  j(['edge', repo, 'tour', 'f_create', 'f_reset', 'clears the count'])
  j(['edge', repo, 'tour', 'f_create', 'f_insert', 'stores the order'])
  j(['edge', repo, 'tour', 'f_create', 'f_push', 'queues the charge'])
  j(['step', repo, 'tour', 'f_create', 'api/orders.js', '9', '10', 'The API checks the order before anything else'], 'A bad order is refused with a reason before any count or row changes.')
  j(['step', repo, 'tour', 'f_allow', 'api/limits.js', '5', '6', 'An hour after the first order the count starts over'], 'The count of the customer is replaced by a new one at one.')
  j(['step', repo, 'tour', 'f_allow', 'api/limits.js', '7', '7', 'The sixth order within the hour is refused'], 'Each order adds one to the count; above five allow says no.')
  j(['step', repo, 'tour', 'f_reset', 'api/limits.js', '11', '13', 'reset forgets one customer\'s count'], 'Only the count of that customer goes; the others keep theirs.')
  j(['step', repo, 'tour', 'f_insert', 'api/store.js', '19', '24', 'An allowed order is stored as pending'], 'The row gets the next order number and waits for the worker.')
  j(['step', repo, 'tour', 'f_push', 'api/queue.js', '23', '25', 'The charge job waits in the queue'], 'A full queue adds nothing and the API says the shop is busy.')
  j(['link', repo, 'tour', '3', 'the count', 'api/limits.js', '2'])
  if (!topUp) execFileSync('node', [script, 'tour-finish', '--steps', 'q1=2,q2=4,q3=4'], { encoding: 'utf8' })
  say({ type: 'result', result: 'The tour is written.', session_id: 'tour-1', is_error: false, total_cost_usd: 0.01 })
}

/** A fix prompt: its instruction (src/check/prompts.ts FIX_HINT) and the note's lines (src/ask/prompts.ts). */
function fixPrompt(p) {
  return /Suggest a fix:/.test(p) && /suggestion block holding the new text of lines/.test(p) ? /left a note on [^\n]*:\n\n```\n([\s\S]*?)\n```/.exec(p) : null
}

/** What the fake does, by the prompt that asks for it (first match wins); `match` returns the parts `run` reads. */
const TASKS = [
  // src/check/prompts.ts checkPrompt: "Start with: <skill>/scripts/questions.mjs start …"
  { name: 'write questions', match: (p) => /Start with: (\S+questions\.mjs) start (.*)/.exec(p), run: writeQuestions },
  { name: 'suggest a fix', match: fixPrompt, run: suggestFix },
  // src/check/prompts.ts tourPrompt: "Start with: <skill>/scripts/questions.mjs tour [--top-up]"
  { name: 'write the tour', match: (p) => /Start with: (\S+questions\.mjs) tour( --top-up)?/.exec(p), run: writeTour },
]

// ---------- grading (cli/understanding/graderPrompt.ts) ----------

/** What the grader prompt says about the answer: GOOD in it passes, CONCERN adds a concern, SLOW grades slowly. */
function gradeInput(p) {
  const answer = (/<answer>\n([\s\S]*?)\n<\/answer>/.exec(p) || [])[1] || ''
  return {
    answer,
    good: /GOOD/.test(answer),
    attempt: Number((/\(attempt (\d+)\)/.exec(p) || [])[1] || 1),
    // A restatement after an explanation.
    restate: /<explanation>/.test(p),
  }
}

const LIMITS_CONCERN = 'api/limits.js:2 keeps counts in memory: a restart lets everyone order again.'
/** The verdict, the first row whose `when` holds. */
const GRADES = [
  { when: (g) => g.restate && g.good, reply: { verdict: 'restated', feedback: 'Right.', note: 'The window restarts.' } },
  { when: (g) => g.restate, reply: { verdict: 'explained', feedback: 'Not yet: the window, not the order.' } },
  { when: (g) => g.good, reply: { verdict: 'pass', feedback: 'Right. The result is kept and sent again.', hint: '', note: 'Kept and sent again.' } },
  { when: (g) => g.attempt >= 2, reply: { verdict: 'explained', feedback: 'It retries with backoff, then keeps the result in a file (worker/worker.js:20).', hint: '' } },
  { when: () => true, reply: { verdict: 'retry', feedback: 'Not quite: what happens after the last try?', hint: 'Look at what the reset function does.', links: [{ phrase: 'the reset function', file: 'api/limits.js', start: 11, end: 13 }] } },
]

function grade(p) {
  const g = gradeInput(p)
  const v = { ...GRADES.find((row) => row.when(g)).reply }
  if (v.verdict === 'pass' && /CONCERN/.test(g.answer)) v.concern = LIMITS_CONCERN
  const text = `Here is my grade:\n${JSON.stringify(v)}`
  const stream = args.includes('stream-json')
  setTimeout(() => {
    if (stream) {
      say({ type: 'system', subtype: 'init' })
      say({ type: 'result', result: text, session_id: 'grade-1', is_error: false })
    } else say({ type: 'result', result: text, is_error: false })
  }, /SLOW/.test(g.answer) ? 1500 : 50)
}

const task = TASKS.map((t) => ({ t, m: t.match(prompt) })).find((x) => x.m)
if (task) task.t.run(task.m)
else grade(prompt)
