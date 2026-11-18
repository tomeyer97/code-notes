// Commit and push: the check file (and only the files named) committed, the branch pushed (the extension's Commit
// & push, and `commit`).
import fs from 'node:fs'
import path from 'node:path'
import { currentBranch, gitError, gitRun } from './git.mjs'
import { fileFor } from './checkFile.mjs'
import { foldDiffs, foldMissing } from './init.mjs'

/**
 * Commits `files` (only those) with `message` when they have changes, then pushes the branch: to its upstream, or with
 * `-u` to its remote (branch.<b>.pushRemote, remote.pushDefault, origin, else the only remote) when it has none.
 * Returns `{ ok, committed, pushed, line }`: `line` is the one thing to tell the person.
 */
export async function commitAndPush(repo, files, message, { env = process.env, timeoutMs = 60_000 } = {}) {
  const g = (args, ms) => gitRun(repo, args, { env, timeoutMs: ms ?? 15_000 })
  const add = await g(['add', '--', ...files])
  if (add.code) return { ok: false, committed: false, pushed: false, line: `Couldn't stage: ${gitError(add.err)}` }
  const staged = await g(['diff', '--cached', '--quiet', '--', ...files])
  let committed = false
  if (staged.code === 1) {
    const c = await g(['commit', '-q', '-m', message, '--', ...files], 60_000)
    if (c.code) return { ok: false, committed: false, pushed: false, line: `Commit failed: ${gitError(c.err || c.out)}` }
    committed = true
  }
  const branch = (await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])).out.trim()
  if (!branch) return { ok: false, committed, pushed: false, line: `${committed ? 'Committed, but not pushed' : 'Not pushed'}: not on a branch.` }
  const conf = async (k) => (await g(['config', '--get', k])).out.trim()
  const upRemote = await conf(`branch.${branch}.remote`), upMerge = await conf(`branch.${branch}.merge`)
  let args, remote
  if (upRemote && upMerge) { remote = (await conf(`branch.${branch}.pushRemote`)) || (await conf('remote.pushDefault')) || upRemote; args = ['push', remote, `HEAD:${remote === upRemote ? upMerge : `refs/heads/${branch}`}`] }
  else {
    const remotes = (await g(['remote'])).out.split('\n').map((x) => x.trim()).filter(Boolean)
    remote = (await conf(`branch.${branch}.pushRemote`)) || (await conf('remote.pushDefault')) || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '')
    if (!remote) return { ok: false, committed, pushed: false, line: `${committed ? 'Committed, but not pushed' : 'Not pushed'}: ${remotes.length ? 'which remote? Push it yourself.' : 'no git remote.'}` }
    args = ['push', '-u', remote, 'HEAD']
  }
  const p = await gitRun(repo, args, { env, timeoutMs })
  // A branch without a merge request: GitLab and GitHub print where to open one.
  const mr = /remote:\s+(https?:\/\/\S+(?:\/merge_requests\/new\S*|\/pull\/new\/\S+))/.exec(`${p.err}\n${p.out}`)?.[1]
  if (!p.code) return { ok: true, committed, pushed: true, line: 'Pushed.', ...(mr ? { mr } : {}) }
  const was = committed ? 'Committed, but the push ' : 'The push '
  if (p.code === -1) return { ok: false, committed, pushed: false, line: `${was}took longer than ${Math.round(timeoutMs / 1000)} s: push it yourself.` }
  if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/.test(p.err)) return { ok: false, committed, pushed: false, line: `${was}was rejected: ${remote} has newer commits. Pull, then push again.` }
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied|access denied|not authorized|\b40[13]\b|Invalid username or password|Host key verification failed/i.test(p.err)) return { ok: false, committed, pushed: false, line: `${was}failed: git couldn't sign in to ${remote}.` }
  return { ok: false, committed, pushed: false, line: `${was}failed: ${gitError(p.err)}` }
}


/**
 * Commits this branch's check file and pushes (`push: false`: only the commit), as Commit & push does in VS Code: the
 * first check of a repository takes the `.gitattributes` line along. Nothing else the person changed is committed.
 */
export async function commitCheck(repo, { env = process.env, push = true } = {}) {
  const branch = currentBranch(repo, env)
  const rel = fileFor(branch)
  if (!fs.existsSync(path.join(repo, rel))) return { ok: false, line: `No check yet: ${rel} doesn't exist.` }
  const files = [rel]
  if (foldMissing(repo)) { foldDiffs(repo); files.push('.gitattributes') }
  const message = `Understanding check: ${branch}`
  if (push) return { ...(await commitAndPush(repo, files, message, { env })), files }
  const g = (args) => gitRun(repo, args, { env })
  if ((await g(['add', '--', ...files])).code) return { ok: false, files, line: "Couldn't stage the check file." }
  if ((await g(['diff', '--cached', '--quiet', '--', ...files])).code !== 1) return { ok: true, committed: false, files, line: 'Nothing to commit.' }
  const c = await g(['commit', '-q', '-m', message, '--', ...files])
  return c.code ? { ok: false, files, line: `Commit failed: ${(c.err || c.out).trim().split('\n')[0]}` } : { ok: true, committed: true, files, line: 'Committed.' }
}
