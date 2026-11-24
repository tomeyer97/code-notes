// The two programs under test, run on a repository: the understanding CLI (cli/understanding.mjs: `main`, `ci`) and
// the understanding-check skill's script (questions.mjs), plus a fake grader (test/fixtures/fake-grader.js).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addAttempt, attemptHash, main, MARKER, readCheck, runCi, writeCheck } from '../../../cli/understanding.mjs'
// repos.mjs builds checks with these functions: only functions are shared both ways (no import is used at load time).
import { ADA, gitIn, sh, sha } from './repos.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const FAKE = path.join(root, 'test/fixtures/fake-grader.js')
export const SCRIPT = path.join(root, 'skills/understanding-check/scripts/questions.mjs')

/**
 * The exit codes of `understanding ci` (docs/understanding-check.md, "In CI"): what a CI job's rules key on. The CLI
 * returns them as bare numbers; these names are the tests' reading of that contract.
 */
export const EXIT = { pass: 0, fail: 1, cannotCheck: 2, advisory: 3 }

/** The CLI's main(args) in `d`: its exit code and what it printed. */
export const run = (d, args, env = {}) => {
  const out = []
  const io = { cwd: d, env: { ...process.env, ...env }, print: (s) => out.push(s) }
  return main(args, io).then((code) => ({ code, out: out.join('\n') }))
}

/** `understanding ci` in `d` with only `env` (and PATH) set. */
export const ci = (d, env) => runCi(d, { env: { PATH: process.env.PATH, ...env } })

/** The CI job's merge request comment without its first line, the marker (checked here). */
export function afterMarker(comment) {
  assert.ok(comment.startsWith(`${MARKER}\n`), comment)
  return comment.slice(MARKER.length + 1)
}

/** The skill's script (questions.mjs) in `d`: its exit code and its output (stdout, then stderr on a failure). */
export const script = (d, ...args) => {
  try {
    return { code: 0, out: sh(d, 'node', [SCRIPT, ...args]) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr ?? ''}` }
  }
}

/**
 * `questions.mjs add` with its options by name: { kind, file, lines ('3-4') or wholeFile, text, also, links,
 * suspect, evidence }. The script's result ({ code, out }).
 */
export function add(d, { kind, file, lines, wholeFile, text, also, links, suspect, evidence }) {
  const args = ['add']
  if (evidence) args.push('--evidence')
  args.push('--kind', kind, '--file', file)
  if (lines) args.push('--lines', lines)
  if (wholeFile) args.push('--whole-file')
  if (text !== undefined) args.push('--text', text)
  if (also) args.push('--also', also)
  if (links) args.push('--links', links)
  if (suspect) args.push('--suspect')
  return script(d, ...args)
}

/** The three questions writeQuestions adds to repo()'s change. */
export const QUESTIONS = [
  { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'What happens when load() throws for one of the steps here?' },
  { kind: 'why', file: 'src/app.js', lines: '10-12', text: 'Why are the steps loaded one by one instead of all at once?' },
  { kind: 'edge', file: 'src/app.js', wholeFile: true, text: 'What does main return when there are no steps to load at all?' },
]

/** A check written through the skill's script, as the agent does. */
export function writeQuestions(d) {
  assert.match(script(d, 'start', '--base', 'main').out, /WRITE: 3 questions/)
  for (const q of QUESTIONS) assert.equal(add(d, q).code, 0)
  const r = script(d, 'finish')
  assert.match(r.out, /WROTE understanding\/feat-x\.json: 3 questions/)
  return path.join(d, 'understanding/feat-x.json')
}

/** Records an answer to `q` (of `check`) as graded: `verdict` and `extra` fields (feedback, topic, …), hash written. */
export function grade(check, q, answer, verdict, extra = {}, by) {
  const a = addAttempt(check, q, answer, by)
  Object.assign(a, { verdict, feedback: '', ...extra })
  a.hash = attemptHash(q, a)
  return a
}

/** Answers the questions of the check `file` as Ada: answers[i] = { text, verdict? } (a verdict is recorded with its hash). */
export const answerAll = (file, answers) => {
  const c = readCheck(file)
  c.questions.forEach((q, i) => {
    if (answers[i] === undefined) return
    const a = addAttempt(c, q, answers[i].text, ADA)
    if (answers[i].verdict) {
      a.verdict = answers[i].verdict
      a.hash = attemptHash(q, a)
    }
  })
  writeCheck(file, c)
}

/** A merge request pipeline's variables on GitLab for feat/x (IID 7 of grp/shop), its API at `api`. */
export const gitlabEnv = (d, api, extra = {}) => ({
  GITLAB_CI: 'true',
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/x',
  CI_COMMIT_SHA: sha(d),
  CI_MERGE_REQUEST_DIFF_BASE_SHA: sha(d, 'main'),
  CI_MERGE_REQUEST_IID: '7',
  CI_PROJECT_ID: 'grp/shop',
  CI_API_V4_URL: api ?? '',
  ...extra,
})

/** `ci` on GitLab with the merge base as the diff base (as GitLab gives it after main moved on). */
export const ciAt = (d) => ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'merge-base', 'main', 'HEAD').trim() }))

/**
 * A pull request workflow's variables on GitHub Actions for feat/x (pull request 5 of o/shop by ada), its API at
 * `api`: the event file is written (beside `d`) from the branch's current head.
 */
export function githubEnv(d, api, extra = {}) {
  const ev = path.join(d, '..', `event-${path.basename(d)}.json`)
  const pr = { number: 5, head: { sha: sha(d), ref: 'feat/x' }, base: { sha: sha(d, 'main') }, user: { login: 'ada' }, labels: [] }
  fs.writeFileSync(ev, JSON.stringify({ pull_request: pr }))
  return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'o/shop', ...(api ? { GITHUB_API_URL: api, GITHUB_TOKEN: 't' } : {}), ...extra }
}

/** A grader log beside `d`: the fake grader writes to it when it runs, so a test can say no grader ran. */
export const graderLog = (d) => path.join(d, '..', `grader-${path.basename(d)}.log`)
