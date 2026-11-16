#!/usr/bin/env node
// A stand-in for `claude -p` in the understanding check's tests. As the grader (json on stdin, or stream-json with the
// prompt after -p): passes an answer that says "GOOD", otherwise asks again (first try) or explains (later tries).
// Asked to write the questions ("questions.mjs start …" in the prompt): runs the skill's script as Claude would.
const fs = require('fs')
const { execFileSync } = require('child_process')
const args = process.argv.slice(2)
if (process.env.FAKE_GRADER_LOG) fs.appendFileSync(process.env.FAKE_GRADER_LOG, JSON.stringify(args) + '\n')
const fromArg = args[args.indexOf('-p') + 1]
const prompt = fromArg && !fromArg.startsWith('--') ? fromArg : fs.readFileSync(0, 'utf8')
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const start = /Start with: (\S+questions\.mjs) start (.*)/.exec(prompt)
if (start) {
  const script = start[1]
  const run = (...a) => { say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `${script} ${a.join(' ')}` } }] } }); return execFileSync('node', [script, ...a], { encoding: 'utf8' }) }
  say({ type: 'system', subtype: 'init' })
  run('start', ...start[2].trim().split(/\s+/))
  run('add', '--kind', 'failure', '--file', 'api/limits.js', '--lines', '4-7', '--text', 'What does allow() do for a customer whose window has already expired?')
  run('add', '--kind', 'why', '--file', 'api/limits.js', '--lines', '10-12', '--text', 'Why is the count kept per customer rather than per order here?')
  run('add', '--kind', 'edge', '--file', 'api/limits.js', '--whole-file', '--text', 'What happens to the counts when the API process restarts?')
  // A test switches branches while the questions are being written: it leaves this file to say so.
  const slow = require('path').join(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim(), 'fake-slow')
  if (fs.existsSync(slow)) { fs.writeFileSync(`${slow}-waiting`, ''); const until = Date.now() + 8000; while (fs.existsSync(slow) && Date.now() < until) execFileSync('sleep', ['0.1']) }
  run('finish')
  say({ type: 'result', result: 'q1 failure\nq2 why\nq3 edge', session_id: 'write-1', is_error: false })
  process.exit(0)
}
// "Suggest a fix" on a concern: one sentence and a suggestion block for the note's lines (a comment added on top).
const fix = /Suggest a fix:/.test(prompt) && /suggestion block holding the new text of lines/.test(prompt) && /left a note on [^\n]*:\n\n```\n([\s\S]*?)\n```/.exec(prompt)
if (fix) {
  const text = `Keep the counts somewhere that survives a restart.\n\n\`\`\`suggestion\n// FIXED: counts survive a restart\n${fix[1]}\n\`\`\``
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'result', result: text, session_id: 'fix-1', is_error: false }) + '\n')
  process.exit(0)
}
// Asked to write the tour ("questions.mjs tour" in the prompt): a journey of the feat/limits change with journey.py, as
// Claude would, then tour-finish. FAKE_TOUR_FAIL (or .git/fake-no-tour): it stops after `tour` (no journey).
const tour = /Start with: (\S+questions\.mjs) tour( --top-up)?/.exec(prompt)
if (tour) {
  const script = tour[1]
  const path = require('path')
  const J = process.env.JOURNEY_PY
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  say({ type: 'system', subtype: 'init' })
  const out = execFileSync('node', [script, 'tour', ...(tour[2] ? ['--top-up'] : [])], { encoding: 'utf8' })
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `${script} tour` } }] } })
  const dir = /--dir (\S+)/.exec(out)[1]
  const j = (args, input) => { say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `${J} ${args[0]} …` } }] } }); return execFileSync('python3', [J, ...args, '--dir', dir], { encoding: 'utf8', input: input ?? '' }) }
  // A test that is not about the tour leaves .git/fake-no-tour: no tour is written (as when Claude gives up).
  const noTour = fs.existsSync(path.join(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim(), 'fake-no-tour'))
  if (process.env.FAKE_TOUR_FAIL || noTour) { say({ type: 'result', result: 'PROBLEM: gave up', session_id: 'tour-1', is_error: false }); process.exit(0) }
  if (process.env.FAKE_TOUR_SLOW) execFileSync('sleep', [process.env.FAKE_TOUR_SLOW])
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
  if (!tour[2]) execFileSync('node', [script, 'tour-finish', '--steps', 'q1=2,q2=4,q3=4'], { encoding: 'utf8' })
  say({ type: 'result', result: 'The tour is written.', session_id: 'tour-1', is_error: false, total_cost_usd: 0.01 })
  process.exit(0)
}
const answer = (/<answer>\n([\s\S]*?)\n<\/answer>/.exec(prompt) || [])[1] || ''
const attempt = Number((/\(attempt (\d+)\)/.exec(prompt) || [])[1] || 1)
// A restatement after an explanation: "restated" when it says GOOD.
const restate = /<explanation>/.test(prompt)
const concern = /CONCERN/.test(answer) ? { concern: 'api/limits.js:2 keeps counts in memory: a restart lets everyone order again.' } : {}
const v = restate ? (/GOOD/.test(answer) ? { verdict: 'restated', feedback: 'Right.', note: 'The window restarts.' } : { verdict: 'explained', feedback: 'Not yet: the window, not the order.' })
  : /GOOD/.test(answer) ? { verdict: 'pass', feedback: 'Right. The result is kept and sent again.', hint: '', note: 'Kept and sent again.', ...concern }
  : attempt >= 2 ? { verdict: 'explained', feedback: 'It retries with backoff, then keeps the result in a file (worker/worker.js:20).', hint: '' }
  : { verdict: 'retry', feedback: 'Not quite: what happens after the last try?', hint: 'Look at what the reset function does.', links: [{ phrase: 'the reset function', file: 'api/limits.js', start: 11, end: 13 }] }
const text = `Here is my grade:\n${JSON.stringify(v)}`
const stream = args.includes('stream-json')
const delay = /SLOW/.test(answer) ? 1500 : 50
setTimeout(() => {
  if (stream) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'result', result: text, session_id: 'grade-1', is_error: false }) + '\n')
  } else process.stdout.write(JSON.stringify({ type: 'result', result: text, is_error: false }) + '\n')
}, delay)
