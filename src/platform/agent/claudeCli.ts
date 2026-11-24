// Finds the `claude` CLI (Claude Code) to run: the setting, else the newest install among PATH and the usual places
// (by `claude --version`), cached per setting and PATH. No vscode API here.
import { execFile, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** "2.1.322 (Claude Code)" -> [2,1,322]. */
export function parseVersion(out: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}
const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** How long a candidate's `claude --version` may take. */
const VERSION_TIMEOUT_MS = 5000
/** A candidate's `claude --version` output ('' when it fails): blocking, or not. */
const versionSync = (c: string): string => `${spawnSync(c, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS }).stdout ?? ''}`
const versionAsync = (c: string): Promise<string> => new Promise((resolve) => {
  execFile(c, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS }, (_e, stdout) => resolve(`${stdout ?? ''}`))
})

let found: { key: string; cli?: string } | undefined
/**
 * The `claude` CLI: the setting if given, else the NEWEST install among PATH and the usual places (VS Code's PATH
 * often finds an old global install before the one you update, e.g. nvm's). The understanding CLI's `grade`, run in a
 * terminal, finds its own (UNDERSTANDING_CLAUDE, else `claude` on PATH: cli/understanding/graderBackends.mjs).
 */
export function findCli(setting: string | undefined): string | undefined {
  const p = lookup(setting)
  if (p.done) return p.cli
  const versions = new Map(unique(p.all).map((c) => [c, versionSync(c)]))
  return choose(p, versions)
}

/**
 * findCli without blocking: each candidate's `--version` runs as its own process, all at once, and the extension
 * host keeps going meanwhile (a `claude --version` takes a few hundred ms). Fills findCli's cache.
 */
export async function findCliAsync(setting: string | undefined): Promise<string | undefined> {
  const p = lookup(setting)
  if (p.done) return p.cli
  const all = unique(p.all)
  const versions = new Map(await Promise.all(all.map(async (c) => [c, await versionAsync(c)] as const)))
  return choose(p, versions)
}

/** What findCli and findCliAsync share before any `--version` runs: the cache (per setting and PATH), the setting. */
function lookup(setting: string | undefined): { done: true; cli: string | undefined } | { done: false; key: string; all: string[] } {
  const key = `${setting ?? ''}|${process.env.PATH ?? ''}`
  if (found?.key === key) return { done: true, cli: found.cli }
  const all = candidates(setting)
  if (setting && all[0] === setting) { found = { key, cli: setting }; return { done: true, cli: setting } }
  return { done: false, key, all }
}
/** The newest candidate by its `--version` output (else the first), cached. */
function choose(p: { key: string; all: string[] }, versions: Map<string, string>): string | undefined {
  found = { key: p.key, cli: newest(p.all, (c) => versions.get(c) ?? '') ?? p.all[0] }
  return found.cli
}

/** The candidates, one per real file (the first path that leads to it). */
function unique(all: string[]): string[] {
  const seen = new Set<string>()
  return all.filter((c) => {
    let real: string
    try { real = fs.realpathSync(c) } catch { return false }
    if (seen.has(real)) return false
    seen.add(real)
    return true
  })
}
/** The candidate whose `--version` says the newest version. */
function newest(all: string[], version: (c: string) => string): string | undefined {
  let best: { cli: string; v: number[] } | undefined
  for (const c of unique(all)) {
    const v = parseVersion(version(c))
    if (v && (!best || newer(v, best.v) > 0)) best = { cli: c, v }
  }
  return best?.cli
}

/** Where `claude` may be: the setting, each PATH folder, the usual install places, nvm's Node versions (executables only). */
function candidates(setting: string | undefined): string[] {
  const candidates: string[] = []
  if (setting) candidates.push(setting)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'claude'))
  const home = os.homedir()
  candidates.push(path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/usr/local/bin/claude')
  try {
    const nvm = path.join(home, '.nvm/versions/node')
    for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, v, 'bin/claude'))
  } catch { /* no nvm */ }
  return candidates.filter((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true } catch { return false } })
}
