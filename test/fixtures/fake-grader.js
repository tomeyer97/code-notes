#!/usr/bin/env node
// A stand-in for `claude -p --output-format json` as the understanding check's grader: reads the prompt on stdin
// (or after -p), passes an answer that says "GOOD", otherwise asks again (first try) or explains (later tries).
const fs = require('fs')
const args = process.argv.slice(2)
if (process.env.FAKE_GRADER_LOG) fs.appendFileSync(process.env.FAKE_GRADER_LOG, JSON.stringify(args) + '\n')
const fromArg = args[args.indexOf('-p') + 1]
const prompt = fromArg && !fromArg.startsWith('--') ? fromArg : fs.readFileSync(0, 'utf8')
const answer = (/<answer>\n([\s\S]*?)\n<\/answer>/.exec(prompt) || [])[1] || ''
const attempt = Number((/\(attempt (\d+)\)/.exec(prompt) || [])[1] || 1)
const v = /GOOD/.test(answer) ? { verdict: 'pass', feedback: 'Right: the result is kept and sent again.', hint: '' }
  : attempt >= 2 ? { verdict: 'explained', feedback: 'It retries with backoff, then keeps the result in a file (worker/worker.js:20).', hint: '' }
  : { verdict: 'retry', feedback: 'Not quite: what happens after the last try?', hint: 'Look at what report() does after its loop.' }
const text = `Here is my grade:\n${JSON.stringify(v)}`
const stream = args.includes('stream-json')
const delay = /SLOW/.test(answer) ? 1500 : 50
setTimeout(() => {
  if (stream) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'result', result: text, session_id: 'grade-1', is_error: false }) + '\n')
  } else process.stdout.write(JSON.stringify({ type: 'result', result: text, is_error: false }) + '\n')
}, delay)
