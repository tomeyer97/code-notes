// Renames git knows, and a short-lived cache of them per folder (the step tracker asks once per step). The sources are
// the ones `journey.py check` reads (the skill's script keeps the same rules in Python; test/fixtures/git-renames.json
// holds the parsing cases both should pass). No vscode API at run time (only its types): unit-tested.
import type * as vscode from 'vscode'
import { gitRaw, HISTORY_GIT } from './git'

/** A commit id as a journey stores it (`since`): anything else is not asked about. */
const COMMIT_ID = /^[0-9a-f]{4,40}$/i
/** Without a known commit to start from: renames in this many recent commits. */
const RECENT_COMMITS = ['-n', '500']

/** The sources of renames, in the order they are applied (a later one wins). */
const RENAME_SOURCES = {
  /** Committed in `range`, oldest first: `R<score>\tfrom\tto` lines. */
  committed: (range: string[]) => ['log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', ...range],
  /** Staged or not, against HEAD: the same lines. */
  uncommitted: ['diff', '-M', '--name-status', 'HEAD'],
  /** Staged renames as `status` names them (`R  a -> b`): a `git mv` not yet seen as a rename by `diff`. */
  status: ['status', '--porcelain=v1'],
}

/** `--name-status` lines `R<score>\tfrom\tto` as from -> to. */
export function parseNameStatus(text: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const l of text.split('\n')) {
    const f = l.split('\t')
    if (f.length === 3 && f[0].startsWith('R')) out.set(f[1], f[2])
  }
  return out
}

/** `status --porcelain=v1` lines `R  "a" -> "b"` (quotes only around odd names) as a -> b. */
export function parseStatus(text: string, out: Map<string, string> = new Map()): Map<string, string> {
  const unquote = (s: string) => s.replace(/^"|"$/g, '')
  for (const l of text.split('\n')) {
    if (l[0] !== 'R' || !l.includes(' -> ')) continue
    const [a, b] = l.slice(3).split(' -> ')
    out.set(unquote(a), unquote(b))
  }
  return out
}

/** old path -> new path, from git; empty when git or the repo is missing. `since`: a commit (unknown or missing: the
 *  recent history). */
export async function gitRenames(cwd: string, since?: string): Promise<Map<string, string>> {
  const git = async (args: string[]) => (await gitRaw(cwd, args, HISTORY_GIT)) ?? ''
  const known = since && COMMIT_ID.test(since) && (await git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`])).trim()
  const range = known ? [`${since}..HEAD`] : RECENT_COMMITS
  const out = new Map<string, string>()
  parseNameStatus(await git(RENAME_SOURCES.committed(range)), out)
  parseNameStatus(await git(RENAME_SOURCES.uncommitted), out)
  parseStatus(await git(RENAME_SOURCES.status), out)
  return out
}

/** How long git's renames are reused (one locate asks once per step). */
const GIT_CACHE_MS = 3000

/** Renames git knows (gitRenames), cached briefly. */
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
