// Finds the `claude` CLI (Claude Code) to run: the setting, else the newest install among PATH and the usual places
// (by `claude --version`, each run as its own process, never blocking), remembered per setting and PATH.
// No vscode API here: the understanding CLI can use the same rule.
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { compareVersions, parseVersion, Version } from './versions'

/**
 * Where Claude Code's installers put `claude`, besides PATH (relative to the home folder unless absolute): the native
 * installer, the old local install (`claude migrate-installer`), a global npm install, and every Node version of nvm
 * (its folders newest name first). From Claude Code's setup docs; Windows has no fixed place (PATH only).
 */
export const INSTALL_PLACES: readonly string[] = [
  '.local/bin/claude',
  '.claude/local/claude',
  '/usr/local/bin/claude',
]
/** nvm's Node versions, each with its own global npm installs. */
const NVM_VERSIONS = '.nvm/versions/node'

/** How long a candidate's `claude --version` may take. */
const VERSION_TIMEOUT_MS = 5000

const isExecutable = (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true, () => false)
const realPath = (p: string) => fs.promises.realpath(p).catch(() => undefined)

/** A candidate's `claude --version` output ('' when it fails). */
const versionOf = (c: string): Promise<string> => new Promise((resolve) => {
  execFile(c, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS }, (_e, stdout) => resolve(`${stdout ?? ''}`))
})

/** nvm's `bin/claude` of each installed Node version, newest folder name first (none without nvm). */
async function nvmPlaces(home: string): Promise<string[]> {
  const nvm = path.join(home, NVM_VERSIONS)
  const versions = await fs.promises.readdir(nvm).catch(() => [] as string[])
  return versions.sort().reverse().map((v) => path.join(nvm, v, 'bin/claude'))
}

/** Where to look: PATH, the home folder, the install places (tests give their own). */
interface Where {
  pathVar: string
  home: string
  places: readonly string[]
}

/** Where `claude` may be: the setting, each PATH folder, the install places (executables only, one per real file). */
async function candidates(setting: string | undefined, where: Where): Promise<string[]> {
  const { pathVar, home } = where
  const onPath = pathVar.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude'))
  const places = where.places.map((p) => (path.isAbsolute(p) ? p : path.join(home, p)))
  const all = [...(setting ? [setting] : []), ...onPath, ...places, ...(await nvmPlaces(home))]
  const ok = await Promise.all(all.map(async (c) => ((await isExecutable(c)) ? await realPath(c) : undefined)))
  const seen = new Set<string>()
  return all.filter((_, i) => {
    const real = ok[i]
    if (!real || seen.has(real)) return false
    seen.add(real)
    return true
  })
}

/** The candidate whose `--version` says the newest version (else the first). */
async function newest(all: string[]): Promise<string | undefined> {
  const versions = await Promise.all(all.map(async (c) => parseVersion(await versionOf(c))))
  let best: { cli: string; v: Version } | undefined
  all.forEach((cli, i) => {
    const v = versions[i]
    if (v && (!best || compareVersions(v, best.v) > 0)) best = { cli, v }
  })
  return best?.cli ?? all[0]
}

/**
 * The `claude` CLI: the setting if it can be run, else the NEWEST install among PATH and the install places (VS
 * Code's PATH often finds an old global install before the one you update, e.g. nvm's).
 */
export async function findClaude(setting: string | undefined, where: Partial<Where> = {}): Promise<string | undefined> {
  if (setting && (await isExecutable(setting))) return setting
  const all = { pathVar: process.env.PATH ?? '', home: os.homedir(), places: INSTALL_PLACES, ...where }
  return newest(await candidates(setting, all))
}

/** findClaude, remembered per setting and PATH: one search at a time, and an answer that is there without waiting. */
export class ClaudeCliFinder {
  private found?: { key: string; cli?: string }
  private searching?: { key: string; search: Promise<string | undefined> }

  /**
   * `onSkipped`: the setting names no program, so `used` (another install, or none) runs instead; said once per
   * search, so a typo never quietly runs (and bills) a different install.
   */
  constructor(
    private readonly search = findClaude,
    private readonly onSkipped?: (setting: string, used: string | undefined) => void,
  ) {}

  /** The CLI for `setting`: the answer found before, else a search (one at a time per setting and PATH). */
  find(setting: string | undefined): Promise<string | undefined> {
    const key = `${setting ?? ''}|${process.env.PATH ?? ''}`
    if (this.found?.key === key) return Promise.resolve(this.found.cli)
    if (this.searching?.key === key) return this.searching.search
    const search = this.search(setting).then((cli) => {
      if (this.searching?.search === search) {
        this.found = { key, cli }
        this.searching = undefined
        if (setting && cli !== setting) this.onSkipped?.(setting, cli)
      }
      return cli
    })
    this.searching = { key, search }
    return search
  }

  /**
   * The CLI as far as it is known now, without running anything: the answer found before, or the setting when it is a
   * program; undefined (and a search starts) when it isn't known yet.
   */
  known(setting: string | undefined): string | undefined {
    const key = `${setting ?? ''}|${process.env.PATH ?? ''}`
    if (this.found?.key === key) return this.found.cli
    this.find(setting).catch(() => undefined)
    if (setting && settingRuns(setting)) return setting
    return undefined
  }
}

/** The setting names a program (a file check, no process). */
function settingRuns(setting: string): boolean {
  try { fs.accessSync(setting, fs.constants.X_OK); return true } catch { return false }
}
