#!/usr/bin/env node
// The grader against a REAL model, on cases where a grader once said wrong things about the code (costs a few cents;
// not part of `npm test`). Builds a copy of examples/shop with a refunds change (test/fixtures/grader-cases), writes
// three questions with the skill's script, grades fixed answers and checks each reply: the verdict, its length, and
// claims it must not make.
//
//   node test/grader/eval.mjs [--model sonnet] [--cases A1,B2] [--runs 1] [--cli path/to/understanding.mjs] [--keep]
//
// The two traps: (A) notify.js's orderConfirmation stamps receipt_sent_at AFTER sending and never reads it, so it
// protects nothing; (B) refunds.js looks the Idempotency-Key up BEFORE taking the lock, and the table has
// UNIQUE (order_number, idempotency_key): two same-key requests at once both miss the lookup, the second one's INSERT
// then fails on the constraint (an error, not a second refund and not a replay); (C) worker/alerts.js mails low-stock
// alerts to OPS_EMAIL, which the worker's deployment never sets: the alerts go nowhere (a concern about the code).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const cliPath = path.resolve(flag('cli', path.join(root, 'cli/understanding.mjs')))
const U = await import(pathToFileURL(cliPath).href)
const model = flag('model', 'sonnet')
const runs = Number(flag('runs', '1'))
const only = flag('cases', '')?.split(',').filter(Boolean)

const ID = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
const sh = (cwd, cmd, a) => execFileSync(cmd, a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, UNDERSTANDING_CLI: path.join(root, 'cli/understanding.mjs') } })

function build() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-eval-'))
  const fx = path.join(root, 'test/fixtures/grader-cases')
  fs.cpSync(path.join(root, 'examples/shop'), d, { recursive: true })
  fs.cpSync(path.join(fx, 'base'), d, { recursive: true })
  sh(d, 'git', ['init', '-q', '-b', 'main']); sh(d, 'git', ['add', '-A']); sh(d, 'git', ['commit', '-qm', 'shop'])
  sh(d, 'git', ['checkout', '-qb', 'feat/refunds'])
  fs.cpSync(path.join(fx, 'change'), d, { recursive: true })
  sh(d, 'git', ['add', '-A']); sh(d, 'git', ['commit', '-qm', 'refunds'])
  const script = path.join(root, 'skills/understanding-check/scripts/questions.mjs')
  const add = (...a) => sh(d, 'node', [script, 'add', ...a])
  sh(d, 'node', [script, 'start', '--base', 'main'])
  add('--kind', 'failure', '--file', 'worker/notify.js', '--lines', '33-39', '--text', 'If sendMail throws in refundNotice after the mail server already accepted the message, what happens to the job?')
  add('--kind', 'edge', '--file', 'api/refunds.js', '--lines', '11-13', '--text', 'What happens when two refund requests with the same Idempotency-Key for one order arrive at the same time?')
  add('--kind', 'why', '--file', 'api/refunds.js', '--lines', '18-20', '--text', 'Why is the order row locked before the remaining refundable amount is checked?')
  add('--kind', 'failure', '--file', 'worker/alerts.js', '--lines', '5-12', '--text', 'Where do the low-stock alerts end up once this runs in production?')
  sh(d, 'node', [script, 'finish'])
  return d
}

const words = (s) => (s.match(/\S+/g) ?? []).length
const CASES = [
  { id: 'A1', q: 'q1', answer: 'tick() catches the throw and retries the job with backoff, so if the mail already went out the customer gets a second refund email.',
    verdict: 'pass', maxWords: 25,
    never: [/receipt_sent_at[^.]*(prevent|protect|guard|stop|skip|avoid)/i, /(no|without|lacks?|missing)[^.]*(marker|flag|guard|check)[^.]*(like|unlike|as|that)[^.]*(orderConfirmation|receipt_sent_at)/i, /orderConfirmation[^.]*(is|stays) (safe|protected|idempotent)/i] },
  { id: 'B1', q: 'q2', prior: ["I don't know."], answer: "Still not sure. Maybe it's just for performance.",
    verdict: 'explained', maxWords: 60,
    never: [/(would|could|will|gets?|be|are) (be )?refunded twice/i, /both (requests )?(go on to |would |could )?(refund|insert)(?! fails)/i, /two refunds (are|get|would be) (made|created|inserted)/i],
    must: [/unique/i] },
  { id: 'B2', q: 'q2', answer: 'Both requests miss the lookup and both insert a refund row, so the customer is refunded twice.',
    verdict: 'retry', maxWords: 45,
    // A miss says what to re-check, never the outcome.
    never: [/(wrong|not|n't|\bno\b)[^.]{0,40}(refunded twice|double refund|two refunds)/i, /unique[^.]*(error|fail|reject|violat|throw)/i, /(error|fail|reject|violat|throw)[^.]*unique/i, /duplicate key/i, /\b500\b/] },
  // Said back after an explanation, in the author's words: restated.
  { id: 'R1', q: 'q2', prior: ["I don't know.", { answer: 'Still not sure.', verdict: 'explained', feedback: 'The lookup runs before the lock, so two same-key requests both miss it; the second then fails on the UNIQUE key: an error, not a replay and not a second refund.' }],
    answer: 'Both miss the early lookup; the unique key makes the second one error out instead of refunding again.', verdict: 'restated', maxWords: 20 },
  // A plausible answer about code that doesn't work as deployed: the grader must raise a concern, not a plain pass.
  { id: 'C1', q: 'q4', answer: 'They are emailed to the ops address in OPS_EMAIL.', verdict: undefined, maxWords: 60,
    mustConcern: /OPS_EMAIL/ },
  { id: 'B3', q: 'q2', answer: 'Both miss the lookup; the second waits on the row lock, then its INSERT violates the unique key and errors instead of replaying.',
    verdict: 'pass', maxWords: 25, never: [/refunded twice/i] },
]

const repo = build()
console.log(`repo: ${repo}\ncli:  ${path.relative(root, cliPath) || cliPath}\nmodel: ${model}\n`)
let bad = 0, cost = 0
for (const c of CASES.filter((x) => !only?.length || only.includes(x.id))) {
  for (let r = 0; r < runs; r++) {
    const file = path.join(repo, 'understanding/feat-refunds.json')
    const check = U.readCheck(file)
    const q = check.questions.find((x) => x.id === c.q)
    q.attempts = []
    for (const p of c.prior ?? []) { const x = typeof p === 'string' ? { answer: p, verdict: 'retry', feedback: 'Not quite.', hint: 'Look at the lookup and the lock.' } : p; const a = U.addAttempt(check, q, x.answer); Object.assign(a, { ...x, answer: x.answer }); a.hash = U.attemptHash(q, a) }
    U.addAttempt(check, q, c.answer)
    const t0 = Date.now()
    let a
    try { a = await U.gradeQuestion(repo, check, q, { backend: 'claude', model }) } catch (e) { console.log(`${c.id}: ! ${e.message}\n`); bad++; continue }
    const text = `${a.feedback} ${a.hint ?? ''}`
    const problems = [
      c.verdict && a.verdict !== c.verdict && `verdict ${a.verdict}, expected ${c.verdict}`,
      c.mustConcern && !c.mustConcern.test(a.concern ?? '') && 'no concern about OPS_EMAIL',
      // Code is named and linked, never pointed at by line numbers.
      /\blines? \d+|:\d+(-\d+)?\b/.test(text) && 'line numbers in the text',
      words(text) > c.maxWords && `${words(text)} words, at most ${c.maxWords}`,
      ...(c.never ?? []).filter((re) => re.test(text)).map((re) => `says ${re}`),
      ...(c.must ?? []).filter((re) => !re.test(text)).map((re) => `misses ${re}`),
    ].filter(Boolean)
    if (problems.length) bad++
    console.log(`${c.id} ${problems.length ? '✗' : '✓'} ${a.verdict} · ${words(text)} words · ${Math.round((Date.now() - t0) / 1000)}s${problems.length ? `\n  PROBLEMS: ${problems.join('; ')}` : ''}`)
    console.log(`  feedback: ${a.feedback}${a.hint ? `\n  hint: ${a.hint}` : ''}${a.concern ? `\n  concern: ${a.concern}` : ''}${a.links ? `\n  links: ${a.links.map((l) => `"${l.phrase}" → ${l.file}:${l.start}-${l.end}`).join('; ')}` : ''}\n`)
  }
}
if (!args.includes('--keep')) fs.rmSync(repo, { recursive: true, force: true })
console.log(bad ? `${bad} problem(s)` : 'all cases fine')
process.exitCode = bad ? 1 : 0
