// How the extension calls git, in one place: one runner (its timeout, its environment, its trimming) and the parsers
// of `git status --porcelain=v2 -z` (the paths it lists, the branch it names). No vscode here: unit tests use it as is.
import { execFile } from 'child_process'

/**
 * The environment of the extension's git commands: no optional lock (a `git status` then never rewrites the index, so
 * another watcher, VS Code's Git view or ours, sees no change). A command that writes still takes the locks it needs.
 */
export const READ_ONLY_GIT: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' }
/** A git command that takes longer than this is given up (the caller sees undefined). */
const GIT_TIMEOUT_MS = 5000

/** git's output (trimmed), or undefined when it fails; `allowEmpty`: an empty output is '' (else undefined). With READ_ONLY_GIT. */
export function gitOut(repo: string, args: string[], allowEmpty = false): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...READ_ONLY_GIT } }, (err, out) => {
      resolve(err ? undefined : out.trim() || (allowEmpty ? '' : undefined))
    })
  })
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
