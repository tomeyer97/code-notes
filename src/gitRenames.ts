// Renames git knows, the way `journey.py check` finds them, and a short-lived cache of them per folder (the step
// tracker asks once per step). No vscode API at run time (only its types): unit-tested.
import type * as vscode from 'vscode'
import { gitRaw } from './git'

type Git = (args: string[]) => Promise<string>

/** Renames committed since `since` (a commit; unknown or missing: the last 500 commits), plus those staged or not. */
async function committedRenames(git: Git, since: string | undefined): Promise<string> {
  const known = since && /^[0-9a-f]{4,40}$/i.test(since) && (await git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`])).trim()
  const range = known ? [`${since}..HEAD`] : ['-n', '500']
  const log = await git(['log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', ...range])
  return log + (await git(['diff', '-M', '--name-status', 'HEAD']))
}

/** `--name-status` lines `R<score>\tfrom\tto` as from -> to. */
function parseNameStatus(text: string, out: Map<string, string>): void {
  for (const l of text.split('\n')) {
    const f = l.split('\t')
    if (f.length === 3 && f[0].startsWith('R')) out.set(f[1], f[2])
  }
}

/** `status --porcelain=v1` lines `R  "a" -> "b"` (quotes only around odd names) as a -> b. */
function parseStatus(text: string, out: Map<string, string>): void {
  const unquote = (s: string) => s.replace(/^"|"$/g, '')
  for (const l of text.split('\n')) {
    if (l[0] !== 'R' || !l.includes(' -> ')) continue
    const [a, b] = l.slice(3).split(' -> ')
    out.set(unquote(a), unquote(b))
  }
}

/** A long history's rename log can pass execFile's 1 MiB default. */
const RENAMES_MAX_OUTPUT = 8 << 20

/** old path -> new path, from git (the same sources as `journey.py check`); empty when git or the repo is missing. */
export async function gitRenames(cwd: string, since?: string): Promise<Map<string, string>> {
  const git: Git = async (args) => (await gitRaw(cwd, args, { maxBuffer: RENAMES_MAX_OUTPUT })) ?? ''
  const out = new Map<string, string>()
  parseNameStatus(await committedRenames(git, since), out)
  parseStatus(await git(['status', '--porcelain=v1']), out)
  return out
}

/** How long git's renames are reused (one locate asks once per step). */
const GIT_CACHE_MS = 3000

/** Renames git knows (as `journey.py check` finds them: committed since a commit, staged, uncommitted), cached briefly. */
export class GitRenameCache {
  private cache = new Map<string, { at: number; map: Promise<Map<string, string>> }>()

  get(folder: vscode.WorkspaceFolder, since?: string): Promise<Map<string, string>> {
    const k = `${folder.uri.toString()}|${since ?? ''}`
    const c = this.cache.get(k)
    if (c && Date.now() - c.at < GIT_CACHE_MS) return c.map
    const map = gitRenames(folder.uri.fsPath, since)
    this.cache.set(k, { at: Date.now(), map })
    return map
  }

  /** Where git says `file` went since `since` (following a chain of renames); undefined: no rename known. */
  async follow(folder: vscode.WorkspaceFolder, since: string | undefined, file: string): Promise<string | undefined> {
    const m = await this.get(folder, since)
    let f = file
    const seen = new Set([f])
    while (m.has(f)) {
      f = m.get(f)!
      if (seen.has(f)) break
      seen.add(f)
    }
    return f !== file ? f : undefined
  }
}
