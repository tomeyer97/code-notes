// Commit and push: the check file (and only the files named) committed, the branch pushed (the extension's Commit
// & push, and `commit`).
import fs from 'node:fs'
import path from 'node:path'
import { currentBranch, gitError, gitRun } from './git'
import { fileFor } from './checkFile'
import { foldDiffs, foldMissing } from './init'
import type { CommitResult, PushResult } from './types'

/** git's result (gitRun). */
type GitResult = Awaited<ReturnType<typeof gitRun>>
/** git with the caller's timeouts (commitFiles). */
type Git = (args: string[], ms?: number) => Promise<GitResult>
/** commitFiles's result: committed or not, or the line that says why it failed. */
type Committed = { committed: boolean; failed?: undefined } | { failed: string; committed?: undefined }
/** Where to push (pushTarget): `remote` and `args`, or `why` not. */
type PushTarget = { remote?: string; args?: string[]; why?: string }

/**
 * Commits `files` (only those) with `message` when they have changes, then pushes the branch: to its upstream, or with
 * `-u` to its remote (branch.<b>.pushRemote, remote.pushDefault, origin, else the only remote) when it has none.
 * `push: false`: only the commit. Returns `{ ok, committed, pushed, line }`: `line` is the one thing to tell the person.
 */
export async function commitAndPush(repo: string, files: string[], message: string, { env = process.env, timeoutMs = 60_000, push = true }: { env?: NodeJS.ProcessEnv; timeoutMs?: number; push?: boolean } = {}): Promise<PushResult> {
  const g: Git = (args, ms) => gitRun(repo, args, { env, timeoutMs: ms ?? 15_000 })
  const done = await commitFiles(g, files, message)
  if (done.failed !== undefined) return notPushed(false, done.failed)
  const committed = done.committed
  if (!push) return { ok: true, committed, pushed: false, line: committed ? 'Committed.' : 'Nothing to commit.' }
  const was = committed ? 'Committed, but not pushed' : 'Not pushed'
  const branch = (await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])).out.trim()
  if (!branch) return notPushed(committed, `${was}: not on a branch.`)
  const target = await pushTarget(g, branch)
  if (target.why) return notPushed(committed, `${was}: ${target.why}`)
  // In English whatever the locale: pushFailure reads git's messages.
  const p = await gitRun(repo, target.args!, { env: { ...env, LC_ALL: 'C' }, timeoutMs })
  const mr = MR_LINK.exec(`${p.err}\n${p.out}`)?.[1]
  if (!p.code) return { ok: true, committed, pushed: true, line: 'Pushed.', ...(mr ? { mr } : {}) }
  return notPushed(committed, pushFailure(p, { committed, remote: target.remote!, timeoutMs }))
}

const notPushed = (committed: boolean, line: string): PushResult => ({ ok: false, committed, pushed: false, line })

/** How long a commit may take (a hook may run). */
const COMMIT_MS = 60_000

/**
 * Stages `files` and commits them when they have staged changes (`g`: git with the caller's timeouts):
 * `{ committed }`, or `{ failed }`: the line to tell the person.
 */
async function commitFiles(g: Git, files: string[], message: string): Promise<Committed> {
  const add = await g(['add', '--', ...files])
  if (add.code) return { failed: `Couldn't stage: ${gitError(add.err)}` }
  // Exit 1: the files have staged changes.
  const staged = await g(['diff', '--cached', '--quiet', '--', ...files])
  if (staged.code !== 1) return { committed: false }
  const c = await g(['commit', '-q', '-m', message, '--', ...files], COMMIT_MS)
  return c.code ? { failed: `Commit failed: ${gitError(c.err || c.out)}` } : { committed: true }
}

/**
 * Where the branch is pushed: `{ remote, args }` (git push's arguments), or `{ why }` when there is no remote to push
 * to. With an upstream: to it (or to the remote chosen for pushes); without: `-u` to the chosen remote, origin, or the
 * only one. The order git itself follows for `git push` (branch.<name>.pushRemote, remote.pushDefault,
 * branch.<name>.remote): https://git-scm.com/docs/git-config#Documentation/git-config.txt-branchltnamegtpushRemote
 */
async function pushTarget(g: Git, branch: string): Promise<PushTarget> {
  const conf = async (k: string): Promise<string> => (await g(['config', '--get', k])).out.trim()
  const upRemote = await conf(`branch.${branch}.remote`), upMerge = await conf(`branch.${branch}.merge`)
  // Set by hand: where this branch (or every branch) pushes.
  const chosen = async () => (await conf(`branch.${branch}.pushRemote`)) || (await conf('remote.pushDefault'))
  if (upRemote && upMerge) {
    const remote = (await chosen()) || upRemote
    return { remote, args: ['push', remote, `HEAD:${remote === upRemote ? upMerge : `refs/heads/${branch}`}`] }
  }
  const remotes = (await g(['remote'])).out.split('\n').map((x) => x.trim()).filter(Boolean)
  const remote = (await chosen()) || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '')
  if (!remote) return { why: remotes.length ? 'which remote? Push it yourself.' : 'no git remote.' }
  return { remote, args: ['push', '-u', remote, 'HEAD'] }
}

// git's own words, matched below: the push runs with LC_ALL=C so they are English in every locale (they may still
// change between git versions: an unknown failure falls back to git's first line).
/** A branch without a merge request: GitLab and GitHub print where to open one. */
const MR_LINK = /remote:\s+(https?:\/\/\S+(?:\/merge_requests\/new\S*|\/pull\/new\/\S+))/
/** The remote has commits the branch doesn't. */
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|\(stale info\)/
/** git couldn't sign in (no credentials: GIT_TERMINAL_PROMPT is off). */
const NO_SIGN_IN = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied|access denied|not authorized|\b40[13]\b|Invalid username or password|Host key verification failed/i

/** Why the push (`p`: git's result) failed, as the line to tell the person. */
function pushFailure(p: GitResult, { committed, remote, timeoutMs }: { committed: boolean; remote: string; timeoutMs: number }): string {
  const was = committed ? 'Committed, but the push ' : 'The push '
  if (p.code === -1) return `${was}took longer than ${Math.round(timeoutMs / 1000)} s: push it yourself.`
  if (REJECTED.test(p.err)) return `${was}was rejected: ${remote} has newer commits. Pull, then push again.`
  if (NO_SIGN_IN.test(p.err)) return `${was}failed: git couldn't sign in to ${remote}.`
  return `${was}failed: ${gitError(p.err)}`
}

/**
 * Commits this branch's check file and pushes (`push: false`: only the commit), as Commit & push does in VS Code: the
 * first check of a repository takes the `.gitattributes` line along. Nothing else the person changed is committed.
 */
export async function commitCheck(repo: string, { env = process.env, push = true }: { env?: NodeJS.ProcessEnv; push?: boolean } = {}): Promise<CommitResult> {
  const branch = currentBranch(repo, env)
  const rel = fileFor(branch)
  if (!fs.existsSync(path.join(repo, rel))) return { ok: false, line: `No check yet: ${rel} doesn't exist.` }
  const files = [rel]
  if (foldMissing(repo)) {
    foldDiffs(repo)
    files.push('.gitattributes')
  }
  const done = await commitAndPush(repo, files, `Understanding check: ${branch}`, { env, push })
  return { ...done, files }
}
