// Which of a journey's steps changed since the commit its podcast was recorded for: the "Code changed since recording"
// line. git's answer is kept a few seconds (a scan reads every podcast; scans come in bursts); when git can't say,
// the output says why once, instead of the line just not appearing.

import { changedFiles } from '../platform/gitChanged'
import { fileOf, LoadedJourney } from '../journeys/steps'

const CACHE_MS = 10_000

/** The steps (by number) whose file is among `files`: as it is now, or as the journey writes it. */
export function stepsTouching(lj: Pick<LoadedJourney, 'j' | 'at'>, files: Set<string>): number[] {
  const out: number[] = []
  lj.j.steps.forEach((s, k) => {
    if (files.has(fileOf(lj, k + 1)) || files.has(s.file)) out.push(k + 1)
  })
  return out
}

/** git's answers per journey and commit. `say`: where "git can't say" goes (once per journey and commit). */
export class ChangedSince {
  private cache = new Map<string, { at: number; steps: number[] | undefined }>()
  /** The journeys and commits whose "git can't say" was logged. */
  private said = new Set<string>()
  constructor(private readonly say: (line: string) => void) {}

  /** The steps of `lj` whose file changed since `commit`, by number; undefined when git can't say. */
  async steps(lj: Pick<LoadedJourney, 'key' | 'folder' | 'j' | 'at'>, commit: string): Promise<number[] | undefined> {
    const key = `${lj.key}|${commit}`
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.steps
    const steps = await this.ask(lj, commit, key)
    this.cache.set(key, { at: Date.now(), steps })
    return steps
  }

  private async ask(lj: Pick<LoadedJourney, 'key' | 'folder' | 'j' | 'at'>, commit: string, key: string): Promise<number[] | undefined> {
    if (lj.folder.uri.scheme !== 'file') return undefined
    const r = await changedFiles(lj.folder.uri.fsPath, commit)
    if ('files' in r) return stepsTouching(lj, r.files)
    if (!this.said.has(key)) {
      this.said.add(key)
      this.say(`podcast of journey ${lj.j.id}: can't tell which steps changed since recording: ${r.why}`)
    }
    return undefined
  }
}
