// What the CLI tests share (test/cli/*.test.mjs): git repositories made here for the check, the CLI and the skill's
// script run on them, a fake grader (test/fixtures/fake-grader.js), and fake GitLab/GitHub APIs (local HTTP servers).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as U from '../../cli/understanding.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const FAKE = path.join(root, 'test/fixtures/fake-grader.js')
export const SCRIPT = path.join(root, 'skills/understanding-check/scripts/questions.mjs')
/** Who commits in these repositories. */
export const ID = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
/** Runs `cmd` in `cwd` as Ada; its output. */
export const sh = (cwd, cmd, args, env = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, ...env } })
export const gitIn = (cwd, ...args) => sh(cwd, 'git', args)

// ---------- repositories ----------

/** A new repository on main, Ada's, with src/app.js: `main` returning 0 (committed). */
function newRepo(...folders) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'))
  gitIn(d, 'init', '-q', '-b', 'main')
  gitIn(d, 'config', 'user.name', 'Ada')
  gitIn(d, 'config', 'user.email', 'ada@example.com')
  for (const f of ['src', ...folders]) fs.mkdirSync(path.join(d, f))
  fs.writeFileSync(path.join(d, 'src/app.js'), 'export function main() {\n  return 0\n}\n')
  gitIn(d, 'add', '-A')
  gitIn(d, 'commit', '-qm', 'init')
  gitIn(d, 'checkout', '-qb', 'feat/x')
  return d
}

/** main: a small file; feat/x: a 70-code-line change in src/app.js (3 questions). */
export function repo() {
  const d = newRepo()
  const body = Array.from({ length: 70 }, (_, i) => `  const v${i} = load(${i}) // step ${i}`).join('\n')
  fs.writeFileSync(path.join(d, 'src/app.js'), `export function main() {\n${body}\n  return 0\n}\n`)
  gitIn(d, 'commit', '-qam', 'change')
  return d
}

/** main: app.js; feat/x: `lines` (an array) appended to `file` (app.js by default). */
export function smallRepo(lines, file = 'src/app.js') {
  const d = newRepo('docs')
  fs.appendFileSync(path.join(d, file), lines.join('\n') + '\n')
  gitIn(d, 'add', '-A')
  gitIn(d, 'commit', '-qm', 'change')
  return d
}

export const commitAll = (d, msg = 'check') => {
  gitIn(d, 'add', '-A')
  gitIn(d, 'commit', '-qm', msg)
}

/** The check's settings committed on main and merged into the branch: CI judges a merge request by its target's settings. */
export const configOnMain = (d, text) => {
  const b = gitIn(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  gitIn(d, 'checkout', '-q', 'main')
  fs.mkdirSync(path.join(d, 'understanding'), { recursive: true })
  fs.writeFileSync(path.join(d, 'understanding/config.json'), text)
  commitAll(d, 'settings')
  gitIn(d, 'checkout', '-q', b)
  gitIn(d, 'merge', '-q', '--no-edit', 'main')
}

// ---------- the CLI and the skill's script ----------

/** The CLI's main(args) in `d`: its exit code and what it printed. */
export const run = (d, args, env = {}) => {
  const out = []
  const io = { cwd: d, env: { ...process.env, ...env }, print: (s) => out.push(s) }
  return U.main(args, io).then((code) => ({ code, out: out.join('\n') }))
}

/** The skill's script (questions.mjs) in `d`: its exit code and its output (stdout, then stderr on a failure). */
export const script = (d, ...args) => {
  try {
    return { code: 0, out: sh(d, 'node', [SCRIPT, ...args]) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr ?? ''}` }
  }
}

/** A check written through the skill's script, as the agent does. */
export function writeQuestions(d) {
  assert.match(script(d, 'start', '--base', 'main').out, /WRITE: 3 questions/)
  assert.equal(script(d, 'add', '--kind', 'failure', '--file', 'src/app.js', '--lines', '3-6', '--text', 'What happens when load() throws for one of the steps here?').code, 0)
  assert.equal(script(d, 'add', '--kind', 'why', '--file', 'src/app.js', '--lines', '10-12', '--text', 'Why are the steps loaded one by one instead of all at once?').code, 0)
  assert.equal(script(d, 'add', '--kind', 'edge', '--file', 'src/app.js', '--whole-file', '--text', 'What does main return when there are no steps to load at all?').code, 0)
  const r = script(d, 'finish')
  assert.match(r.out, /WROTE understanding\/feat-x\.json: 3 questions/)
  return path.join(d, 'understanding/feat-x.json')
}

/** Answers the questions of the check `file` as Ada: answers[i] = { text, verdict? } (a verdict is recorded with its hash). */
export const answerAll = (file, answers) => {
  const c = U.readCheck(file)
  c.questions.forEach((q, i) => {
    if (answers[i] === undefined) return
    const a = U.addAttempt(c, q, answers[i].text, { name: 'Ada', email: 'ada@example.com' })
    if (answers[i].verdict) {
      a.verdict = answers[i].verdict
      a.hash = U.attemptHash(q, a)
    }
  })
  U.writeCheck(file, c)
}

/** A branch whose check passed, with main moving on: main gets 260 lines in its own file, the branch keeps app.js. */
export function divergedRepo() {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d, 'answers')
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/refunds.js'), Array.from({ length: 260 }, (_, i) => `export const r${i} = ${i}`).join('\n') + '\n')
  commitAll(d, 'refunds on main')
  gitIn(d, 'checkout', '-q', 'feat/x')
  return { d, f }
}

/** GitLab users of the fake API: the bot (the token's user) and a reviewer. */
export const BOT = { id: 1, username: 'understanding-ci' }
export const BOB = { id: 2, username: 'bob' }

/** A passed check whose q1 carries a concern flagged by Bob; `set(concern, extra?)` changes it (and the check) and commits. */
export function concernRepo() {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  const set = (concern, extra = (c) => c) => {
    const c = U.readCheck(f)
    c.questions[0].concern = concern
    extra(c)
    U.writeCheck(f, c)
    commitAll(d, 'concern')
  }
  set({ text: 'load() errors are swallowed; tell @carol', flagged: true, by: { name: 'Bob' } })
  return { d, f, set }
}

// ---------- CI and the forges' APIs ----------

/** A merge request pipeline's variables on GitLab for feat/x (IID 7 of grp/shop), its API at `api`. */
export const gitlabEnv = (d, api, extra = {}) => ({
  GITLAB_CI: 'true',
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/x',
  CI_COMMIT_SHA: gitIn(d, 'rev-parse', 'HEAD').trim(),
  CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'rev-parse', 'main').trim(),
  CI_MERGE_REQUEST_IID: '7',
  CI_PROJECT_ID: 'grp/shop',
  CI_API_V4_URL: api ?? '',
  ...extra,
})

/** `understanding ci` in `d` with only `env` (and PATH) set. */
export const ci = (d, env) => U.runCi(d, { env: { PATH: process.env.PATH, ...env } })

/** `ci` on GitLab with the merge base as the diff base (as GitLab gives it after main moved on). */
export const ciAt = (d) => ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'merge-base', 'main', 'HEAD').trim() }))

/** A local HTTP server answering JSON with `answer(req, body)`; returns its url and `close`. */
async function jsonServer(answer) {
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (x) => { b += x })
    req.on('end', () => answer(req, b, res))
  })
  await new Promise((r) => srv.listen(0, r))
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

/** A fake GitLab or GitHub API: canned answers by "METHOD path", every request recorded. */
export async function fakeApi(routes) {
  const calls = []
  const srv = await jsonServer((req, b, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`
    calls.push({ key, body: b ? JSON.parse(b) : undefined, headers: req.headers })
    const h = routes[key]
    res.setHeader('content-type', 'application/json')
    if (!h) {
      res.statusCode = 404
      return res.end('{}')
    }
    res.end(JSON.stringify(typeof h === 'function' ? h(b && JSON.parse(b)) : h))
  })
  return { ...srv, calls }
}

/** A fake API driven by one function: (method, path, body) → [status, json]. Every request recorded. */
export async function fakeServer(handle) {
  const calls = []
  const srv = await jsonServer((req, b, res) => {
    const p = req.url.split('?')[0]
    const body = b ? JSON.parse(b) : undefined
    calls.push({ method: req.method, path: p, body })
    const [status, json] = handle(req.method, p, body) ?? [404, {}]
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(json ?? {}))
  })
  return { ...srv, calls }
}

// ---------- the tour: a journey of the change, written after the questions, embedded in the check file ----------

export const JPY = path.join(root, 'skills/code-journey/scripts/journey.py')

/** The agent's part of a tour: `questions.mjs tour`, then journey.py with the --dir it prints. Returns that --dir. */
export function tourStage(d, topUp = false) {
  const out = script(d, 'tour', ...(topUp ? ['--top-up'] : [])).out
  assert.match(out, /^JOURNEY: \S+journey\.py <command> <repo> tour … --dir (\S+)/m)
  return { out, dir: /--dir (\S+)/.exec(out)[1] }
}

/** journey.py `args` in `d`, writing into the tour's `dir`; `input` on stdin. */
export const jpy = (d, dir, args, input = '') => execFileSync('python3', [JPY, ...args, '--dir', dir], { cwd: d, encoding: 'utf8', input })

/** Six steps through main in src/app.js (the change of repo()). */
export function writeTourSteps(d, dir) {
  jpy(d, dir, ['new', d, 'tour', 'How does main load its steps?', 'Loading steps'], 'Main loads each step in turn. Then it returns zero.')
  jpy(d, dir, ['node', d, 'tour', 'app', 'system', 'App', '--blurb', 'The program'], 'The program.')
  jpy(d, dir, ['node', d, 'tour', 'f_main', 'function', 'main', 'app', 'src/app.js:1-73'], 'Loads the steps.')
  jpy(d, dir, ['node', d, 'tour', 'f_end', 'function', 'the end of main', 'app', 'src/app.js:72-73'], 'Returns.')
  jpy(d, dir, ['edge', d, 'tour', 'f_main', 'f_end', 'returns zero'])
  for (const k of [1, 2, 3, 4, 5]) {
    const lead = `Main loads step number ${k} here`
    jpy(d, dir, ['step', d, 'tour', 'f_main', 'src/app.js', String(k * 10), String(k * 10 + 1), lead], 'Each load call reads one value, in order, before the next one starts.')
  }
  jpy(d, dir, ['step', d, 'tour', 'f_end', 'src/app.js', '72', '72', 'Main returns zero at the end'], 'Nothing is returned but zero, whatever the steps loaded.')
}
