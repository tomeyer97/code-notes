// The understanding check's CLI (cli/understanding.mjs) on a worker thread. Its functions call git synchronously:
// right in a terminal or in CI, but in the extension host each call would stop every extension that shares it (over
// Remote-SSH that host is on the remote machine, and the editor waits on it). Here they stop only this thread. The
// same file, the same functions: the extension and the CLI can't disagree. See cliThread.ts for the other side.
import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { statusBranch, statusPaths } from '../git'
import { importCli } from './importCli'
import type { RefreshResult } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The CLI's functions, called by name from the other side (check/types.ts `Cli` lists the ones the extension uses). */
type CliModule = Record<string, any>
const loaded = importCli<CliModule>((workerData as { cli: string }).cli)
/** The understanding CLI (cli/understanding.mjs), once loaded. */
let cli!: CliModule

/** How long a value read from git (the base branch, who answers) is kept while its key stays the same. */
const MEMO_MS = 300_000

/** A file as a cache key: changes when it is written or replaced, or appears or goes. */
function stamp(file: string): string {
  try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}` } catch { return '-' }
}

/** The repository's git folders (a linked worktree has its own, and shares the common one). */
const dirsOf = new Map<string, { git: string; common: string }>()
function dirs(repo: string): { git: string; common: string } {
  let d = dirsOf.get(repo)
  if (!d) {
    const [git, common] = cli.git(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).trim().split('\n')
    d = { git, common: path.resolve(repo, common ?? git) }
    dirsOf.set(repo, d)
  }
  return d
}

/** Values that rarely change, kept while their key (files git reads them from) stays the same, at most 5 minutes. */
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

/** The branch compared with (the CLI's defaultBase), kept while the branch and the refs it is chosen from stay the same. */
function defaultBase(repo: string, branch: string | undefined): string | undefined {
  const c = dirs(repo).common
  // The refs the CLI chooses from (origin's HEAD, then its DEFAULT_BRANCHES on origin, then local), and packed-refs.
  const names: string[] = cli.DEFAULT_BRANCHES
  const refs = ['packed-refs', 'refs/remotes/origin/HEAD', ...names.map((b) => `refs/remotes/origin/${b}`), ...names.map((b) => `refs/heads/${b}`)]
  const refsKey = refs.map((r) => stamp(path.join(c, r))).join('|')
  return cached(`base\0${repo}`, `${branch}|${refsKey}`, () => cli.defaultBase(repo) as string | undefined)
}

/**
 * Everything a refresh reads, as one hash: HEAD and the branch, every ref (the base, the upstream, a stack's parent,
 * the stash), the working tree's changed files (each with its size and time: editing a changed file again changes no
 * line of `git status`), the check file, its settings and cached copy, the files the caller names, git's config (who
 * answers), and `extra` (what only the caller knows). The same hash: nothing a refresh shows can have changed.
 */
function gateKey(repo: string, o: { files: string[]; untracked: boolean; extra: string }): string {
  const h = createHash('sha1')
  const untracked = `--untracked-files=${o.untracked ? 'all' : 'no'}`
  const st = cli.git(repo, ['status', '--porcelain=v2', '--branch', '-z', untracked]) as string
  h.update(st)
  for (const p of statusPaths(st)) h.update(`\0${p}\0${stamp(path.join(repo, p))}`)
  h.update(cli.git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/stash']))
  // The CLI's currentBranch, without another git call: the status names the branch.
  const head = statusBranch(st)
  const branch = cli.ciBranch() || (head === '(detached)' || !head ? 'HEAD' : head)
  const files = [cli.fileFor(branch), `${cli.DIR}/config.json`, cli.cachedFor(branch), ...o.files]
  for (const f of files) h.update(`\0${f}\0${stamp(path.join(repo, f))}`)
  h.update(`\0${configKey(repo)}\0${o.extra}`)
  return h.digest('hex')
}

/**
 * Where the branch stands (the CLI's localStatus), unless nothing it reads changed since `prev` (then `{ same: true }`).
 * With the identity of who answers (git's user.name and user.email).
 */
function refreshState(repo: string, o: { prev?: string; files?: string[]; untracked?: boolean; extra?: string }): RefreshResult {
  let key: string | undefined
  try { key = gateKey(repo, { files: o.files ?? [], untracked: !!o.untracked, extra: o.extra ?? '' }) } catch { key = undefined }
  if (key && key === o.prev) return { key, same: true }
  let st: RefreshResult['st'], error: string | undefined
  try {
    const branch = cli.currentBranch(repo)
    st = cli.localStatus(repo, { base: defaultBase(repo, branch) })
  } catch (e) { error = String((e as Error)?.message ?? e).split('\n')[0] }
  let ident: RefreshResult['ident']
  try { ident = cached(`who\0${repo}`, configKey(repo), () => cli.gitIdentity(repo)) } catch { ident = undefined }
  return { key, st, error, ident }
}

/** Functions of the worker itself, called by name like the CLI's (they come first). */
const workerFns: Record<string, (...a: any[]) => unknown> = { refreshState }

parentPort!.on('message', async (m: { id: number; fn: string; args: unknown[] }) => {
  try {
    cli ??= await loaded
    const f = workerFns[m.fn] ?? cli[m.fn]
    if (typeof f !== 'function') throw new Error(`no function ${m.fn}`)
    const v = await f(...m.args)
    parentPort!.postMessage({ id: m.id, ok: true, v })
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, err: String((e as Error)?.message ?? e) })
  }
})
