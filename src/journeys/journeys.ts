import * as vscode from 'vscode'
import { docLines, fileLines } from '../platform/documents'
import { lineEdits } from '../platform/followEdits'
import { GitRenameCache } from '../platform/gitRenames'
import { pathIn } from '../core/paths'
import { StateStore } from '../platform/state'
import { Debouncer } from '../platform/debounce'
import { REFIND_STEPS_MS } from '../platform/timings'
import { AnyAnchor, Found } from '../core/anchors/compact'
import { LoadedJourney, posKey } from './steps'
import { StepLocator } from './stepLocator'
import { InvalidJourney, JourneyRepository } from './repository'
import { CheckTours } from './checkTours'
import { keys } from './keys'
import { whenThere } from './fileStates'

export { journeysFolderName } from './repository'

// The journeys feature's model, put together: the journey files (repository.ts), the checks' tours (checkTours.ts)
// and where their steps are (stepLocator.ts), three objects with one job each. This hands what is read to the
// locator and the editor's events to it; the methods below that only pass a call on keep the API the tour, the panel,
// the podcast and the lists use (new code can use `files`, `tours` and `locator` directly).

/** A read-only map over several maps, in their order (the checks' tours, then the journey files). */
class Joined<V> implements ReadonlyMap<string, V> {
  constructor(private readonly parts: () => ReadonlyMap<string, V>[]) {}
  get(k: string): V | undefined {
    for (const m of this.parts()) {
      const v = m.get(k)
      if (v !== undefined) return v
    }
    return undefined
  }
  has(k: string): boolean { return this.get(k) !== undefined }
  get size(): number { return this.parts().reduce((n, m) => n + m.size, 0) }
  *entries(): MapIterator<[string, V]> { for (const m of this.parts()) yield* m.entries() }
  *keys(): MapIterator<string> { for (const [k] of this.entries()) yield k }
  *values(): MapIterator<V> { for (const [, v] of this.entries()) yield v }
  [Symbol.iterator](): MapIterator<[string, V]> { return this.entries() }
  forEach(f: (v: V, k: string, m: ReadonlyMap<string, V>) => void): void { for (const [k, v] of this.entries()) f(v, k, this) }
}

export class Journeys implements vscode.Disposable {
  readonly locator: StepLocator
  readonly files: JourneyRepository
  readonly tours: CheckTours
  /** Every loaded journey by key: the journey files and the checks' tours (`all()` is the journey files only). */
  readonly list: ReadonlyMap<string, LoadedJourney> = new Joined(() => [this.tours.listed, this.files.listed])
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  /** Steps moved or went stale (no journey file changed). */
  private readonly moved = new vscode.EventEmitter<LoadedJourney>()
  readonly onDidMoveSteps = this.moved.event
  private readonly git = new GitRenameCache()
  /** Edited documents waiting for the typing to stop, by journey and file. */
  private readonly pending = new Debouncer('journeys: find the steps again')

  constructor(private readonly log: vscode.LogOutputChannel, stored?: StateStore) {
    this.locator = new StepLocator({
      lines: (lj, file) => fileLines(vscode.Uri.joinPath(lj.folder.uri, file)),
      gitFollow: (lj, file) => this.git.follow(lj.folder, lj.j.commit, file),
      moved: (lj) => this.moved.fire(lj),
      log,
    }, stored)
    const changed = () => this.changed.fire()
    this.files = new JourneyRepository({ track: (lj) => this.locator.track(lj), changed, log })
    this.tours = new CheckTours({ locate: (lj) => this.locator.locate(lj), changed, log })
  }

  /** The journeys of the lists, lenses and search: never a check's tour (it is reached from the Check view).
   *  By title: an order that never jumps while journeys change. */
  all(): LoadedJourney[] { return [...this.files.values()].sort((a, b) => a.j.title.localeCompare(b.j.title)) }

  byPos(key: string | undefined): LoadedJourney | undefined {
    return key ? [...this.list.values()].find((x) => posKey(x) === key) : undefined
  }

  /** The journey of file `uri` once it is listed (the watcher read it), or undefined after `ms`. */
  listed(uri: vscode.Uri, ms: number): Promise<LoadedJourney | undefined> {
    return whenThere(() => this.files.get(uri.toString()), (f) => this.onDidChange(f), ms)
  }

  // ---------- the editor's events: the steps follow ----------

  /** An edit in an editor (typing, an applied fix): steps in that document keep up with it (StepLocator.followEdits). */
  onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file' || !e.contentChanges.length) return
    const lastFirst = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start))
    const changes = lineEdits(lastFirst)
    for (const lj of this.list.values()) {
      const rel = pathIn(lj.folder.uri, e.document.uri)
      if (rel !== undefined) this.locator.followEdits(lj, rel, changes)
    }
  }

  /** An edited document: the steps in it found again, a moment after typing stops. */
  onDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') return
    for (const lj of this.list.values()) {
      const rel = pathIn(lj.folder.uri, doc.uri)
      if (rel === undefined || !this.locator.hasStepsIn(lj, rel)) continue
      this.pending.later(keys.journeyFile(lj.key, rel), REFIND_STEPS_MS, () => this.relocateDocument(lj, rel, doc))
    }
  }

  private async relocateDocument(lj: LoadedJourney, rel: string, doc: vscode.TextDocument): Promise<void> {
    // Replaced (read again) or gone meanwhile.
    if (this.list.get(lj.key) !== lj) return
    // Clean after the change: the file was reloaded from disk (a checkout, an agent), not edited here.
    await this.locator.relocateDocument(lj, rel, docLines(doc), !doc.isDirty)
  }

  // ---------- passed on (the API other features use) ----------

  /** The journey files that were never readable, by URI. */
  get invalid(): ReadonlyMap<string, InvalidJourney> { return this.files.invalid }
  /** The text each journey was last read from, by journey key (Restore). */
  readonly lastGood: Pick<ReadonlyMap<string, string>, 'get'> = { get: (key) => this.files.lastGoodTextOf(key) }
  lastGoodText(lj: LoadedJourney): string | undefined { return this.files.lastGoodText(lj) }
  load(): Promise<void> { return this.files.load() }
  reload(uri: vscode.Uri): Promise<LoadedJourney | undefined> { return this.files.reload(uri) }
  setTour(folder: vscode.WorkspaceFolder, uri: vscode.Uri, raw: unknown, branch: string): Promise<LoadedJourney | undefined> {
    return this.tours.set(folder, uri, raw, branch)
  }
  locate(lj: LoadedJourney, only?: (n: number) => boolean, given?: { file: string; lines: string[] }): Promise<boolean> {
    return this.locator.locate(lj, only, given)
  }
  anchorOf(lj: LoadedJourney, n: number): AnyAnchor | undefined { return this.locator.anchorOf(lj, n) }
  findIn(lj: LoadedJourney, n: number, lines: string[]): Found { return this.locator.findIn(lj, n, lines) }
  moveStep(lj: LoadedJourney, n: number, file: string): Promise<void> { return this.locator.moveStep(lj, n, file) }
  renames(lj: LoadedJourney): Map<string, string> { return this.locator.renames(lj) }
  relocateOnDisk(paths?: Set<string>): Promise<void> { return this.locator.relocateOnDisk(this.list.values(), paths) }

  dispose(): void {
    this.files.dispose()
    this.pending.dispose()
    this.changed.dispose()
    this.moved.dispose()
  }
}
