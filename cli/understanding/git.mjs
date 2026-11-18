// Running git: `git`/`gitOk` (synchronous, for reading), `gitRun` (asynchronous, for commit and push: no credential
// prompt, a timeout); the branch, its base, a stack's parent, a stash. The extension has its own runner for its own
// git calls (src/git.ts); what it reads through this file runs these on a worker thread (src/check/cliWorker.ts).
import { execFileSync, spawn } from 'node:child_process'
import { DIR } from './constants.mjs'
import { isHex } from './validate.mjs'

export function git(repo, args, opts = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}
const gitOk = (repo, args) => { try { return git(repo, args).trim() } catch { return undefined } }
export const hasCommit = (repo, sha) => !!sha && gitOk(repo, ['cat-file', '-e', `${sha}^{commit}`]) !== undefined
export const repoRoot = (dir) => gitOk(dir, ['rev-parse', '--show-toplevel'])



/** The branch a merge request's pipeline runs for (GitLab, GitHub): CI checks out a detached HEAD. Else undefined. */
export const ciBranch = (env = process.env) => env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.GITHUB_HEAD_REF || undefined

export function currentBranch(repo, env = process.env) {
  return ciBranch(env) || gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD'
}

/** The usual names of a repository's default branch, in the order they are tried. */
export const DEFAULT_BRANCHES = ['main', 'master']

/** The branch a change is compared with, locally: origin's default branch, else main/master (origin's, then local). */
export function defaultBase(repo) {
  const sym = gitOk(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const usual = [...DEFAULT_BRANCHES.map((b) => `origin/${b}`), ...DEFAULT_BRANCHES]
  const cands = [sym?.replace(/^refs\/remotes\//, ''), ...usual].filter(Boolean)
  const cur = gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return cands.find((c) => c !== cur && gitOk(repo, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]))
}
/**
 * A default branch (no check there; no questions written in the background): origin's HEAD when it is known, else main
 * or master; and the branch the change is compared with (`baseRef`, e.g. "origin/develop"), when given.
 */
export function isDefaultBranch(repo, branch, baseRef) {
  const sym = gitOk(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const defaults = sym ? [sym.replace(/^origin\//, '')] : DEFAULT_BRANCHES
  return defaults.includes(branch) || (!!baseRef && branch === baseRef.replace(/^origin\//, ''))
}
export const mergeBase = (repo, a, b) => gitOk(repo, ['merge-base', a, b])
const isAncestor = (repo, a, b) => { try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true } catch { return false } }

/**
 * Stacked branches: the newest check committed on this branch for ANOTHER branch (its file is in the tree at `head`)
 * whose code commit lies between `base` and `head`. The change starts there: that code was checked in its own merge
 * request. `{ base, branch }`, or undefined. Once the parent is merged, its check's commit is behind the merge base and
 * no longer counts.
 */
export function stackBase(repo, base, head, ownFile) {
  if (!base || !head) return undefined
  const files = (gitOk(repo, ['ls-tree', '--name-only', head, `${DIR}/`]) ?? '').split('\n').filter((f) => /\.json$/.test(f) && f !== ownFile && f !== `${DIR}/config.json`)
  let best
  for (const f of files) {
    let c
    try { c = JSON.parse(git(repo, ['show', `${head}:${f}`])) } catch { continue }
    const h = c?.head
    if (!isHex(h) || !hasCommit(repo, h) || h === base) continue
    if (!isAncestor(repo, base, h) || !isAncestor(repo, h, head)) continue
    if (!best || isAncestor(repo, best.base, h)) best = { base: gitOk(repo, ['rev-parse', h]) ?? h, branch: c.branch ?? f }
  }
  // The parent went on after its check (a fix, a TODO, a small addition within its drift): what it has now is its own
  // change, not this branch's. The change starts where this branch left the parent, when the clone has the parent.
  if (best?.branch) {
    for (const ref of [`origin/${best.branch}`, best.branch]) {
      if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) continue
      const fork = mergeBase(repo, ref, head)
      if (fork && fork !== best.base && isAncestor(repo, best.base, fork)) best.base = fork
      break
    }
  }
  return best
}


/** The newest stash that holds `rel` (its untracked part or its changes): "stash@{0}", or undefined. */
export function stashedIn(repo, rel) {
  // The stash's reflog (what `git stash list` reads).
  const refs = (gitOk(repo, ['log', '-g', '--format=%gd', 'refs/stash', '--']) ?? '').split('\n').filter(Boolean)
  return refs.find((r) => gitOk(repo, ['cat-file', '-e', `${r}^3:${rel}`]) !== undefined || gitOk(repo, ['cat-file', '-e', `${r}:${rel}`]) !== undefined)
}


/** Runs git with an argument list (never a shell): `{ code, out, err }`; code -1 when it timed out. */
export function gitRun(repo, args, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    // No credential prompt can be answered here: git fails at once instead of waiting for one.
    const p = spawn('git', args, { cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', done = false
    const t = setTimeout(() => { if (!done) { done = true; p.kill('SIGTERM'); resolve({ code: -1, out, err }) } }, timeoutMs)
    p.stdout.on('data', (b) => { out += b })
    p.stderr.on('data', (b) => { if (err.length < 8000) err += b })
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: 127, out, err: e.message }) } })
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code: code ?? 1, out, err }) } })
  })
}

/** git's error in one line: the first line that says something (no hints, no "To <url>"). */
const gitError = (err) => err.split('\n').map((l) => l.replace(/^(error|fatal|remote):\s*/i, '').trim()).find((l) => l && !/^(hint:|To |!\s*\[|Everything up-to-date)/.test(l)) ?? 'git failed'

export { gitError, gitOk }
