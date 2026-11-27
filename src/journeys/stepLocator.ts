import type * as vscode from 'vscode'
import { JStep } from '../core/format/journeyModel'
import { Loc } from '../core/anchors/anchor'
import { LineEdit, shift, swallows } from '../core/anchors/lineFollow'
import { AnyAnchor, Found, findCompact, toCompact } from '../core/anchors/compact'
import { dirPath } from '../core/paths'
import { StateStore } from '../platform/state'
import { LoadedJourney, StepAt, atOf, fileOf, placeStep, sameStepAt, stepOf } from './steps'
import { StepPlaceStore } from './stepPlaces'
import { keys, StepKey } from './keys'

// Where the steps of the loaded journeys are as the code changes: found again in memory (anchor.ts, compact.ts) after
// edits in an editor, changes on disk and renames; the journey file is never written. The locator is handed the
// journeys (journeys.ts) and reads files through its ports: no vscode at run time, unit-tested with fixture journeys
// (test/stepLocator.test.ts).

/**
 * What the locator needs of a journey: its key, its steps and where they are, and its workspace folder's URI. A
 * LoadedJourney at run time; plain fixture journeys in the unit tests.
 */
export type Locatable = Pick<LoadedJourney, 'key' | 'j' | 'at'> & { folder: { uri: { path: string; toString(): string } } }

export interface StepLocatorPorts<L extends Locatable = LoadedJourney> {
  /** The lines of `file` in the journey's workspace folder; undefined: no such file. */
  lines(lj: L, file: string): Promise<string[] | undefined>
  /** Where git says `file` went since the journey's commit (`git mv`); undefined: git knows of no rename. */
  gitFollow(lj: L, file: string): Promise<string | undefined>
  /** Steps moved or went stale (no journey file changed). */
  moved(lj: L): void
  log: Pick<vscode.LogOutputChannel, 'info'>
}

/** The lines a locate was given (a document's, as typed) instead of the file's on disk. */
export interface GivenLines { file: string; lines: string[] }

export class StepLocator<L extends Locatable = LoadedJourney> {
  private readonly places: StepPlaceStore
  /** The locate (or move) running for each journey, by journey key: they run one after another, never interleaved. */
  private readonly running = new Map<string, Promise<unknown>>()

  /** No `stored` (unit tests): nothing is kept across reloads. */
  constructor(private readonly ports: StepLocatorPorts<L>, stored?: StateStore) {
    this.places = new StepPlaceStore(stored)
  }

  private stepKey(lj: L, n: number): StepKey { return keys.step(lj.key, stepOf(lj, n)) }

  /** Per file, not per journey or step: every journey with a step in that file follows the same rename. */
  private renameKey(lj: L, n: number) { return keys.fileIn(lj.folder.uri, stepOf(lj, n).file) }

  /**
   * A journey read just now: its steps start in the files they followed through renames before a reload, then are
   * found in the code.
   */
  async track(lj: L): Promise<void> {
    lj.j.steps.forEach((s, i) => {
      const f = this.places.renamedTo(this.renameKey(lj, i + 1))
      if (f && !lj.at[i].file && f !== s.file) lj.at[i] = { ...lj.at[i], file: f }
    })
    await this.locate(lj)
  }

  /**
   * Finds the steps' code again (all of them, or `only` some). True if any moved or changed staleness. One at a time
   * per journey, and the journey's `at` is replaced as a whole when done: a reader never sees half a locate, and a
   * later locate (newer lines) never ends before an earlier one.
   */
  locate(lj: L, only?: (n: number) => boolean, given?: GivenLines): Promise<boolean> {
    return this.oneAtATime(lj, () => this.locateNow(lj, only, given))
  }

  private oneAtATime<T>(lj: L, job: () => Promise<T>): Promise<T> {
    const before = this.running.get(lj.key) ?? Promise.resolve()
    const run = before.then(job, job)
    const done: Promise<unknown> = run.then(forget, forget).then(() => {
      if (this.running.get(lj.key) === done) this.running.delete(lj.key)
    })
    this.running.set(lj.key, done)
    return run
  }

  private async locateNow(lj: L, only?: (n: number) => boolean, given?: GivenLines): Promise<boolean> {
    const next = [...lj.at]
    const cache = new Map<string, string[] | undefined>()
    let changed = false
    for (const s of lj.j.steps) {
      if (only && !only(s.n)) continue
      const was = next[s.n - 1]
      const file = was.file ?? s.file
      const { lines, gitFile } = await this.linesFor(lj, s.n, file, cache, given)
      const now = lines ? await this.placeIn(lj, s, was, lines, gitFile) : { ...was, stale: true }
      if (sameStepAt(now, was)) continue
      if (now.stale !== was.stale) this.ports.log.info(`journey ${lj.j.id} step ${s.n}: ${now.stale ? 'stale (its code changed or is gone)' : 'found again'} · ${file}`)
      next[s.n - 1] = now
      changed = true
    }
    if (changed) lj.at = next
    return changed
  }

  /**
   * The lines of the file step `n` is in (read once per locate; `given`: a document's, as typed). The file is gone:
   * git may know where it went (`git mv`), for every journey alike; `gitFile` says where.
   */
  private async linesFor(
    lj: L, n: number, file: string, cache: Map<string, string[] | undefined>, given?: GivenLines,
  ): Promise<{ lines?: string[]; gitFile?: string }> {
    let lines = given && given.file === file ? given.lines : cache.get(file)
    if (!lines && !cache.has(file)) {
      lines = await this.ports.lines(lj, file)
      cache.set(file, lines)
    }
    if (lines) return { lines }
    const gitFile = await this.ports.gitFollow(lj, file)
    const moved = gitFile && await this.ports.lines(lj, gitFile)
    if (!gitFile || !moved) return {}
    cache.set(gitFile, moved)
    this.ports.log.info(`journey ${lj.j.id} step ${n}: ${file} was renamed to ${gitFile} (git)`)
    return { lines: moved, gitFile }
  }

  /** Where step `s` is in its file's `lines`: by its anchor, or where the reader's own edits took it. */
  private placeIn(lj: L, s: JStep, was: StepAt, lines: string[], gitFile: string | undefined): Promise<StepAt> {
    const k = this.stepKey(lj, s.n)
    const nf = gitFile ?? was.file
    const fileField = nf && nf !== s.file ? { file: nf } : {}
    const found = placeStep(lines, this.places.anchorIn(k, s, lines), was, fileField)
    return this.places.resolve(k, found, lines, was, fileField)
  }

  /** True when one of the journey's steps is in `file` (relative to its folder) now. */
  hasStepsIn(lj: L, file: string): boolean {
    return lj.j.steps.some((s) => fileOf(lj, s.n) === file)
  }

  /**
   * An edit in an editor (typing, an applied fix) to `file` of the journey's folder: its steps there keep up with it.
   * A step whose lines the edit touched (without replacing them all) stays on them: `locate` takes them as its code.
   * `changes`: last first.
   */
  followEdits(lj: L, file: string, changes: LineEdit[]): void {
    for (const s of lj.j.steps) if (fileOf(lj, s.n) === file) this.followStepEdits(lj, s.n, changes)
  }

  /** Step `n`'s lines through `changes` (last first); remembered when the edits touched them. */
  private followStepEdits(lj: L, n: number, changes: LineEdit[]): void {
    const at = atOf(lj, n)
    const k = this.stepKey(lj, n)
    const before = this.places.editedAt(k)
    if (!at || (at.stale && !before)) return
    let loc: Loc = before ?? { start: at.start - 1, end: at.end - 1 }
    let touched = !!before, gone = false
    for (const edit of changes) {
      if (swallows(loc, edit)) gone = true
      if (edit.startLine <= loc.end && edit.endLine >= loc.start) touched = true
      loc = shift(loc, edit)
    }
    // Its code replaced as a whole (deleted, a big paste): found again, or stale, as usual.
    if (gone) this.places.forgetEdit(k)
    else if (touched) this.places.setEdited(k, loc)
  }

  /**
   * The document of `file` changed (`lines`, as it is now): its steps found again. `reloaded`: it was reloaded from
   * disk (a checkout, an agent), not edited here, so the edits followed so far are not the reader's.
   */
  async relocateDocument(lj: L, file: string, lines: string[], reloaded: boolean): Promise<void> {
    const inFile = (n: number) => fileOf(lj, n) === file
    if (reloaded) for (const s of lj.j.steps.filter((x) => inFile(x.n))) this.places.forgetEdit(this.stepKey(lj, s.n))
    if (await this.locate(lj, inFile, { file, lines })) this.ports.moved(lj)
  }

  /** What the step's code looked like: from the journey file, or taken from the code when the file had none. */
  anchorOf(lj: L, n: number): AnyAnchor | undefined {
    return this.places.anchorOf(this.stepKey(lj, n), stepOf(lj, n))
  }

  /** Where step `n`'s code is in `lines` (another file's, e.g. one just created): fresh, changed or gone. */
  findIn(lj: L, n: number, lines: string[]): Found {
    const a = this.anchorOf(lj, n)
    const c = a && toCompact(a)
    return c ? findCompact(lines, c, atOf(lj, n).start - 1) : { state: 'gone' }
  }

  /** The step's code is in another file now (renamed): follow it, in memory. */
  async moveStep(lj: L, n: number, file: string): Promise<void> {
    await this.oneAtATime(lj, async () => {
      const back = file === stepOf(lj, n).file
      const at: StepAt = { ...atOf(lj, n), file: back ? undefined : file }
      if (at.file === undefined) delete at.file
      lj.at = lj.at.map((x, i) => (i === n - 1 ? at : x))
      this.ports.log.info(`journey ${lj.j.id} step ${n}: its file moved to ${file}`)
      await this.places.setRenamed(this.renameKey(lj, n), at.file ? file : undefined)
      await this.locateNow(lj, (k) => k === n)
    })
    this.ports.moved(lj)
  }

  /** Renamed files (old -> new path) the journey's steps followed: refs to the old path say where it went. */
  renames(lj: L): Map<string, string> {
    const out = new Map<string, string>()
    lj.j.steps.forEach((s, i) => {
      const f = lj.at[i].file
      if (f) out.set(s.file, f)
    })
    return out
  }

  /**
   * Files changed on disk (git checkout, pull, an agent; not typed in an editor): re-find the steps of `journeys` in
   * them. Without this a step stayed as it was found when the window opened: stale after a branch switch back, fresh
   * after one away. No `paths`: every step (the branch changed).
   */
  async relocateOnDisk(journeys: Iterable<L>, paths?: Set<string>): Promise<void> {
    for (const lj of [...journeys]) {
      const base = dirPath(lj.folder.uri)
      const hit = (n: number) => !paths || paths.has(base + fileOf(lj, n))
      if (!lj.j.steps.some((s) => hit(s.n))) continue
      if (await this.locate(lj, hit)) this.ports.moved(lj)
    }
  }
}

const forget = () => undefined
