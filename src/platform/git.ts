// The extension host's git: one asynchronous runner (its environment, its limits, its trimming), the limits it runs
// with by kind of call (DEFAULT_GIT, QUICK_GIT, HISTORY_GIT), and the parsers of `git status --porcelain=v2 -z`. No
// vscode here: unit tests use it as is.
//
// Not the only git runner yet: the understanding CLI has its own two (cli/understanding/git.mjs: `git`, synchronous,
// 64 MiB, no timeout, run on a worker thread with READ_ONLY_GIT; `gitRun` for commit and push, 60 s). The CLI is plain
// JavaScript today; once it is TypeScript it can use these limits too.
import { execFile } from 'child_process'

/**
 * The environment of the extension's git commands: no optional lock (a `git status` then never rewrites the index, so
 * another watcher, VS Code's Git view or ours, sees no change). A command that writes still takes the locks it needs.
 */
export const READ_ONLY_GIT: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' }

/** How long a git command may take (then the caller sees undefined), and how much output it may print. */
export interface GitLimits { timeoutMs?: number; maxBuffer?: number }

/** Every call unless it says otherwise: reads, and the check's small local writes (add, commit, pull). Output: execFile's
 *  default, 1 MiB. */
export const DEFAULT_GIT = { timeoutMs: 5000 } as const satisfies GitLimits
/** Identity and branch reads on the way to drawing a note: a git that hangs is given up sooner. */
export const QUICK_GIT = { timeoutMs: 3000 } as const satisfies GitLimits
/** A long history's log (the renames since a journey's commit): more output than 1 MiB. */
export const HISTORY_GIT = { maxBuffer: 8 << 20 } as const satisfies GitLimits

/** git's output as printed, or undefined when it fails. With READ_ONLY_GIT; `limits` over DEFAULT_GIT. */
export function gitRaw(repo: string, args: string[], limits: GitLimits = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...READ_ONLY_GIT }
    const max = limits.maxBuffer ? { maxBuffer: limits.maxBuffer } : {} // an undefined maxBuffer would lift the limit
    execFile('git', args, { cwd: repo, env, timeout: limits.timeoutMs ?? DEFAULT_GIT.timeoutMs, ...max }, (err, out) => {
      resolve(err ? undefined : out)
    })
  })
}

/** git's output (trimmed), or undefined when it fails; `allowEmpty`: an empty output is '' (else undefined). With READ_ONLY_GIT. */
export async function gitOut(repo: string, args: string[], allowEmpty = false, limits?: GitLimits): Promise<string | undefined> {
  const out = await gitRaw(repo, args, limits)
  return out === undefined ? undefined : out.trim() || (allowEmpty ? '' : undefined)
}

/** The paths of the entries of `git status --porcelain=v2 -z` output (renames: the new path; headers skipped). */
export function statusPaths(out: string): string[] {
  const recs = out.split('\0')
  const paths: string[] = []
  // Fields before the path: "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path\0orig",
  // "u XY sub m1 m2 m3 mW h1 h2 h3 path", "? path", "! path".
  const skip: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1, '!': 1 }
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    const n = skip[r[0]]
    if (!r || r[1] !== ' ' || n === undefined) continue
    const p = r.split(' ').slice(n).join(' ')
    if (p) paths.push(p)
    if (r[0] === '2') i++ // the original path follows as its own record
  }
  return paths
}

/** The branch `git status --porcelain=v2 --branch` names ("(detached)" when HEAD is detached), or undefined. */
export function statusBranch(out: string): string | undefined {
  for (const r of out.split('\0')) if (r.startsWith('# branch.head ')) return r.slice('# branch.head '.length)
  return undefined
}
