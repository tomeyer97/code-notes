#!/usr/bin/env node
// The grader against a REAL model, on cases where a grader once said wrong things about the code (costs a few cents;
// not part of `npm test`). Builds a copy of examples/shop with a refunds change (test/fixtures/grader-cases), writes
// the questions of cases.json there with the skill's script, grades each case's answer and checks the reply: the
// verdict, its length, and the claims it must or must not make (named in cases.json, so a failure says which).
//
//   node test/grader/eval.mjs [--model sonnet] [--cases A1,B2] [--runs 1] [--cli path/to/understanding.mjs] [--keep]
//
// The traps: (A) notify.js's orderConfirmation stamps receipt_sent_at AFTER sending and never reads it, so it
// protects nothing; (B) refunds.js looks the Idempotency-Key up BEFORE taking the lock, and the table has
// UNIQUE (order_number, idempotency_key): two same-key requests at once both miss the lookup, the second one's INSERT
// then fails on the constraint (an error, not a second refund and not a replay); (C) worker/alerts.js mails low-stock
// alerts to OPS_EMAIL, which the worker's deployment (docker-compose.yml) never sets: the alerts go nowhere (a
// concern about the code).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'test/fixtures/grader-cases')
const args = process.argv.slice(2)
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const cliPath = path.resolve(flag('cli', path.join(root, 'cli/understanding.mjs')))
const U = await import(pathToFileURL(cliPath).href)
const model = flag('model', 'sonnet')
const runs = Number(flag('runs', '1'))
const only = flag('cases', '')?.split(',').filter(Boolean)
const { questions, cases } = JSON.parse(fs.readFileSync(path.join(fixtures, 'cases.json'), 'utf8'))

const ID = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
const sh = (cwd, cmd, a) => execFileSync(cmd, a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, UNDERSTANDING_CLI: path.join(root, 'cli/understanding.mjs') } })

/** The sample repository: examples/shop on main, the refunds change on feat/refunds, the questions written. */
function build() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-eval-'))
  fs.cpSync(path.join(root, 'examples/shop'), d, { recursive: true })
  fs.cpSync(path.join(fixtures, 'base'), d, { recursive: true })
  sh(d, 'git', ['init', '-q', '-b', 'main']); sh(d, 'git', ['add', '-A']); sh(d, 'git', ['commit', '-qm', 'shop'])
  sh(d, 'git', ['checkout', '-qb', 'feat/refunds'])
  fs.cpSync(path.join(fixtures, 'change'), d, { recursive: true })
  sh(d, 'git', ['add', '-A']); sh(d, 'git', ['commit', '-qm', 'refunds'])
  const script = path.join(root, 'skills/understanding-check/scripts/questions.mjs')
  // One question per case family: more than a change this size gets by default.
  fs.mkdirSync(path.join(d, 'understanding'), { recursive: true })
  fs.writeFileSync(path.join(d, 'understanding/config.json'), JSON.stringify({ questions: { min: 1, max: questions.length } }))
  sh(d, 'node', [script, 'start', '--base', 'main'])
  for (const q of questions) sh(d, 'node', [script, 'add', '--kind', q.kind, '--file', q.file, '--lines', q.lines, '--text', q.text])
  sh(d, 'node', [script, 'finish'])
  return d
}

/** A pattern written as "/source/flags" in cases.json. */
const regex = (s) => { const m = /^\/(.*)\/([a-z]*)$/s.exec(s); return new RegExp(m[1], m[2]) }
/** The names of the patterns in `named` (name → pattern) that match `text`, or that don't (`want` false). */
const matching = (named, text, want = true) => Object.entries(named ?? {}).filter(([, re]) => regex(re).test(text) === want).map(([name]) => name)
const words = (s) => (s.match(/\S+/g) ?? []).length

/** What is wrong with the grader's reply `a` to case `c`: one line per problem, none when it is right. */
function checkReply(c, a) {
  const text = `${a.feedback} ${a.hint ?? ''}`
  const problems = [
    ...matching(c.never, text).map((name) => `says it: ${name}`),
    ...matching(c.must, text, false).map((name) => `misses: ${name}`),
    ...matching(c.mustConcern, a.concern ?? '', false).map((name) => `no concern: ${name}`),
    ...matching(c.noteMust, a.note ?? '', false).map((name) => `the reviewer's note misses: ${name}`),
  ]
  if (c.verdict && a.verdict !== c.verdict) problems.push(`verdict ${a.verdict}, expected ${c.verdict}`)
  if (c.noConcern && a.concern) problems.push(`a concern on working code: ${a.concern}`)
  if (c.partial !== undefined && !!a.partial !== c.partial) problems.push(`partial: ${!!a.partial}, expected ${c.partial}`)
  // Code is named and linked, never pointed at by line numbers.
  if (/\blines? \d+|:\d+(-\d+)?\b/.test(text)) problems.push('line numbers in the text')
  if (words(text) > c.maxWords) problems.push(`${words(text)} words, at most ${c.maxWords}`)
  return problems
}

/** Prints the case's line (✓ or ✗, the verdict, its size and time), its problems and the reply. */
function report(c, a, problems, ms) {
  const text = `${a.feedback} ${a.hint ?? ''}`
  console.log(`${c.id} ${problems.length ? '✗' : '✓'} ${a.verdict} · ${words(text)} words · ${Math.round(ms / 1000)}s`)
  for (const p of problems) console.log(`  PROBLEM: ${p}`)
  const lines = [
    ['feedback', a.feedback], ['hint', a.hint], ['note', a.note], ['partial', a.partial && 'true'], ['concern', a.concern],
    ['links', a.links?.map((l) => `"${l.phrase}" → ${l.file}:${l.start}-${l.end}`).join('; ')],
  ]
  for (const [k, v] of lines) if (v) console.log(`  ${k}: ${v}`)
  console.log('')
}

/** The case's question in the check file, with only the case's earlier attempts and its answer. */
function attemptFor(check, c) {
  const q = check.questions.find((x) => x.id === c.q)
  q.attempts = []
  for (const p of c.prior ?? []) {
    const x = typeof p === 'string' ? { answer: p, verdict: 'retry', feedback: 'Not quite.', hint: 'Look at the lookup and the lock.' } : p
    const a = U.addAttempt(check, q, x.answer)
    Object.assign(a, x)
    a.hash = U.attemptHash(q, a)
  }
  U.addAttempt(check, q, c.answer)
  return q
}

const repo = build()
console.log(`repo: ${repo}\ncli:  ${path.relative(root, cliPath) || cliPath}\nmodel: ${model}\n`)
let failed = 0, errors = 0
for (const c of cases.filter((x) => !only?.length || only.includes(x.id))) {
  for (let r = 0; r < runs; r++) {
    const check = U.readCheck(path.join(repo, 'understanding/feat-refunds.json'))
    const q = attemptFor(check, c)
    const t0 = Date.now()
    let a
    try { a = await U.gradeQuestion(repo, check, q, { backend: 'claude', model }) } catch (e) {
      console.log(`${c.id}: ! ${e.message}\n`)
      errors++
      continue
    }
    const problems = checkReply(c, a)
    if (problems.length) failed++
    report(c, a, problems, Date.now() - t0)
  }
}
if (!args.includes('--keep')) fs.rmSync(repo, { recursive: true, force: true })
console.log(failed || errors ? `${failed} case(s) with problems, ${errors} grading error(s)` : 'all cases fine')
process.exitCode = failed || errors ? 1 : 0
