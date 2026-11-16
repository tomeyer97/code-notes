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
