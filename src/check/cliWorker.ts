// The understanding check's CLI (cli/understanding/*.ts) on a worker thread. Its functions call git synchronously:
// right in a terminal or in CI, but in the extension host each call would stop every extension that shares it (over
// Remote-SSH that host is on the remote machine, and the editor waits on it). Here they stop only this thread. The
// same functions as the CLI's: the extension and the CLI can't disagree. cliThread.ts is the other side; `workerApi`
// below is everything it can call.
import { parentPort } from 'worker_threads'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { statusPaths } from '../platform/git'
import { gitIdentity } from '../../cli/understanding/checkFile'
import { codeStat, diffText } from '../../cli/understanding/diff'
import { currentBranch, defaultBase as cliDefaultBase, git } from '../../cli/understanding/git'
import { localStatus, refreshInputs } from '../../cli/understanding/state'
import { errorText, type WorkerReply, type WorkerRequest } from './cliProxy'
import type { RefreshResult } from './types'

/** This file, for `new Worker` (cliThread.ts): a compiled name, not a string kept in step by hand. */
export const WORKER_FILE = __filename

// What the worker keeps between calls, and until when:
//   gitDirs  a repository's git folders               for the worker's life (a moved worktree is another path)
//   memo     the base branch, who answers (git reads)  while the files git reads them from are unchanged, at most 5 min
// A refresh itself caches nothing here: its key (gateKey) goes back to the caller, which passes it in again.

/** How long a value read from git (the base branch, who answers) is kept while its key stays the same. */
const MEMO_MS = 300_000

/** A file as a cache key: changes when it is written or replaced, or appears or goes ('-': not there). */
function stamp(file: string): string {
  try {
    const s = fs.statSync(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    return '-'
  }
}

/** The repository's git folders (a linked worktree has its own, and shares the common one). */
const gitDirs = new Map<string, { git: string; common: string }>()
function dirs(repo: string): { git: string; common: string } {
  let d = gitDirs.get(repo)
  if (!d) {
    const [gitDir, common] = git(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).trim().split('\n')
    d = { git: gitDir, common: path.resolve(repo, common ?? gitDir) }
    gitDirs.set(repo, d)
  }
  return d
}

/** Values that rarely change, kept while their key (files git reads them from) stays the same, at most MEMO_MS. */
const memo = new Map<string, { key: string; at: number; v: unknown }>()
function cached<T>(name: string, key: string, f: () => T): T {
  const m = memo.get(name)
  if (m && m.key === key && Date.now() - m.at < MEMO_MS) return m.v as T
  const v = f()
  memo.set(name, { key, at: Date.now(), v })
  return v
}

/** git's config files, as a key: the identity changes only when one of them does. */
function configKey(repo: string): string {
  const d = dirs(repo)
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const files = [
    path.join(d.git, 'config'),
    path.join(d.common, 'config'),
    process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), '.gitconfig'),
    path.join(xdg, 'git', 'config'),
  ]
  return files.map(stamp).join('|')
}

/** The refs the base branch is chosen from (the CLI's refreshInputs), as a key. */
const refsKey = (repo: string, refs: string[]): string => refs.map((r) => stamp(path.join(dirs(repo).common, r))).join('|')

/** The branch compared with (the CLI's defaultBase), kept while the branch and the refs it is chosen from stay the same. */
function defaultBase(repo: string, branch: string, refs: string[]): string | undefined {
  return cached(`base\0${repo}`, `${branch}|${refsKey(repo, refs)}`, () => cliDefaultBase(repo))
}

/**
 * Everything a refresh reads, as one hash: HEAD and the branch, every ref (the base, the upstream, a stack's parent,
 * the stash), the working tree's changed files (each with its size and time: editing a changed file again changes no
 * line of `git status`), the files and refs the CLI says a status reads (refreshInputs), the files the caller names,
 * git's config (who answers), and `extra` (what only the caller knows). The same hash: nothing a refresh shows can
 * have changed.
 */
function gateKey(repo: string, inputs: { files: string[]; refs: string[] }, o: { files: string[]; untracked: boolean; extra: string }): string {
  const h = createHash('sha1')
  const untracked = `--untracked-files=${o.untracked ? 'all' : 'no'}`
  const st = git(repo, ['status', '--porcelain=v2', '--branch', '-z', untracked])
  h.update(st)
  for (const p of statusPaths(st)) h.update(`\0${p}\0${stamp(path.join(repo, p))}`)
  h.update(git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/stash']))
  for (const f of [...inputs.files, ...o.files]) h.update(`\0${f}\0${stamp(path.join(repo, f))}`)
  h.update(`\0${refsKey(repo, inputs.refs)}\0${configKey(repo)}\0${o.extra}`)
  return h.digest('hex')
}

/**
 * Where the branch stands (the CLI's localStatus), unless nothing it reads changed since `prev` (then `{ same: true }`).
 * With the identity of who answers (git's user.name and user.email). Each part that fails is left out: no key (the
 * next refresh reads again), the error's first line instead of a status, no identity.
 */
function refreshState(repo: string, o: { prev?: string; files?: string[]; untracked?: boolean; extra?: string }): RefreshResult {
  let inputs: ReturnType<typeof refreshInputs> | undefined
  let key: string | undefined
  try {
    inputs = refreshInputs(repo)
    key = gateKey(repo, inputs, { files: o.files ?? [], untracked: !!o.untracked, extra: o.extra ?? '' })
  } catch {
    key = undefined
  }
  if (key && key === o.prev) return { key, same: true }
  let st: RefreshResult['st']
  let error: string | undefined
  try {
    const branch = inputs?.branch ?? currentBranch(repo)
    st = localStatus(repo, { base: defaultBase(repo, branch, inputs?.refs ?? []) })
  } catch (e) {
    error = errorText(e, true)
  }
  let ident: RefreshResult['ident']
  try {
    ident = cached(`who\0${repo}`, configKey(repo), () => gitIdentity(repo))
  } catch {
    ident = undefined
  }
  return { key, st, error, ident }
}

/** What the extension host calls on this thread (through CliThread's `api`): only these, by name. */
export const workerApi = { refreshState, codeStat, diffText }
export type WorkerApi = typeof workerApi

parentPort?.on('message', async (m: WorkerRequest) => {
  let reply: WorkerReply
  try {
    if (!Object.hasOwn(workerApi, m.fn)) throw new Error(`no function ${m.fn}`)
    const f = workerApi[m.fn as keyof WorkerApi] as (...a: unknown[]) => unknown
    reply = { id: m.id, ok: true, v: await f(...m.args) }
  } catch (e) {
    reply = { id: m.id, ok: false, err: errorText(e) }
  }
  parentPort!.postMessage(reply)
})
