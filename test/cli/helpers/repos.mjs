// Git repositories made for the check: a change on feat/x, checks written and answered on it, and git states that
// are awkward to reach (a stash, a bare remote).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readCheck, writeCheck } from '../../../cli/understanding.mjs'
import { answerAll, writeQuestions } from './cli.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
/** Who commits in these repositories. */
export const ADA = { name: 'Ada', email: 'ada@example.com' }
export const ID = { GIT_AUTHOR_NAME: ADA.name, GIT_AUTHOR_EMAIL: ADA.email, GIT_COMMITTER_NAME: ADA.name, GIT_COMMITTER_EMAIL: ADA.email }
/** Runs `cmd` in `cwd` as Ada; its output. `input` goes to stdin. */
export const sh = (cwd, cmd, args, env = {}, input) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, ...env }, input })
export const gitIn = (cwd, ...args) => sh(cwd, 'git', args)
/** The commit id of `ref` in `d`. */
export const sha = (d, ref = 'HEAD') => gitIn(d, 'rev-parse', ref).trim()

/** A new repository on main, Ada's, with src/app.js: `main` returning 0 (committed). */
function newRepo(...folders) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'))
  gitIn(d, 'init', '-q', '-b', 'main')
  gitIn(d, 'config', 'user.name', ADA.name)
  gitIn(d, 'config', 'user.email', ADA.email)
  for (const f of ['src', ...folders]) fs.mkdirSync(path.join(d, f))
  fs.writeFileSync(path.join(d, 'src/app.js'), 'export function main() {\n  return 0\n}\n')
  gitIn(d, 'add', '-A')
  gitIn(d, 'commit', '-qm', 'init')
  gitIn(d, 'checkout', '-qb', 'feat/x')
  return d
}

/** `n` lines of code, `line(i)` each, as one text ending in a newline. */
export const codeLines = (n, line) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

/** main: a small file; feat/x: a 70-code-line change in src/app.js (3 questions). */
export function repo() {
  const d = newRepo()
  const body = codeLines(70, (i) => `  const v${i} = load(${i}) // step ${i}`)
  fs.writeFileSync(path.join(d, 'src/app.js'), `export function main() {\n${body}  return 0\n}\n`)
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

/** Appends `n` new code lines to src/app.js (drift), committed unless `commit` is false. */
export function grow(d, n, { commit = true, name = 'z' } = {}) {
  fs.appendFileSync(path.join(d, 'src/app.js'), codeLines(n, (i) => `export const ${name}${i} = ${i}`))
  if (commit) commitAll(d, `${n} more lines`)
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

/** Three answers with these verdicts, in order (`undefined`: not answered). */
export const verdicts = (...vs) => vs.map((v, i) => (v ? { text: 'abc'[i] ?? 'x', verdict: v } : undefined))

/**
 * repo() with its check written and answered with `answers` (all three passed by default), committed: the state most
 * CI tests start from. Returns the repository and the check file.
 */
export function checkedRepo(answers = verdicts('pass', 'pass', 'pass'), { commit = true } = {}) {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, answers)
  if (commit) commitAll(d, 'answers')
  return { d, f }
}

/** Changes the check file `f` with `edit(check)`, then commits it (`msg`). */
export function editCheck(d, f, edit, msg = 'check edited') {
  const c = readCheck(f)
  edit(c)
  writeCheck(f, c)
  commitAll(d, msg)
}

/** A branch whose check passed, with main moving on: main gets 260 lines in its own file, the branch keeps app.js. */
export function divergedRepo() {
  const { d, f } = checkedRepo()
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/refunds.js'), codeLines(260, (i) => `export const r${i} = ${i}`))
  commitAll(d, 'refunds on main')
  gitIn(d, 'checkout', '-q', 'feat/x')
  return { d, f }
}

/** A passed check whose q1 carries a concern flagged by Bob; `set(concern, extra?)` changes it (and the check) and commits. */
export function concernRepo() {
  const { d, f } = checkedRepo(verdicts('pass', 'pass', 'pass'), { commit: false })
  const set = (concern, extra = (c) => c) => editCheck(d, f, (c) => {
    c.questions[0].concern = concern
    extra(c)
  }, 'concern')
  set({ text: 'load() errors are swallowed; tell @carol', flagged: true, by: { name: 'Bob' } })
  return { d, f, set }
}

/** An empty bare repository (a remote to push to). */
export function bareRemote() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-remote-'))
  gitIn(bare, 'init', '-q', '--bare')
  return bare
}

/**
 * Puts the untracked `file` (relative to `d`) into a stash as `git stash -u` leaves it, and removes it from the
 * working tree. Built with plumbing: a stash commit whose parents are HEAD, an index commit (HEAD's tree) and a commit
 * of the untracked files (here: only `file`), so the test does not depend on what `git stash` would also pick up.
 * Returns the file's text.
 */
export function stashUntracked(d, file) {
  const git = (args, input) => sh(d, 'git', args, {}, input).trim()
  const text = fs.readFileSync(path.join(d, file), 'utf8')
  const head = git(['rev-parse', 'HEAD'])
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  // The untracked tree: `file` alone, one tree per folder of its path, innermost first.
  const parts = file.split('/')
  let entry = `100644 blob ${git(['hash-object', '-w', '--stdin'], text)}\t${parts.pop()}\n`
  for (const dir of parts.reverse()) entry = `040000 tree ${git(['mktree'], entry)}\t${dir}\n`
  const commit = (t, msg, ...parents) => git(['commit-tree', t, ...parents.flatMap((p) => ['-p', p]), '-m', msg])
  const untracked = commit(git(['mktree'], entry), 'untracked')
  const index = commit(tree, 'index', head)
  git(['update-ref', '--create-reflog', '-m', 'WIP', 'refs/stash', commit(tree, 'WIP', head, index, untracked)])
  fs.rmSync(path.join(d, file))
  return text
}
