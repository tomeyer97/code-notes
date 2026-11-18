import * as vscode from 'vscode'
import { wfs } from '../wfs'
import { isOldFormat, parseJourney } from '../journeyModel'
import { folderName, journeysFolderName } from '../store'
import { jsonFilesIn, watchJsonFiles } from '../jsonFolder'
import { LoadedJourney, carryPositions, pathIn, posKey, writtenAt } from './steps'
import { StepTracker } from './tracker'

// Journeys (format v2, docs/journey-format.md): <repo>/journeys/<slug>.json (codeNotes.journeys.folder: committed,
// shared) and, as before, <notes folder>/journeys/<slug>.json (personal); steps embedded. A step is not a note. This
// loads and watches the files and holds the checks' tours; where the steps are as the code changes is tracker.ts.

const decoder = new TextDecoder()

export class Journeys extends StepTracker {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  private watchers: vscode.Disposable[] = []
  /** The last readable text of each journey file (by URI): Restore after a delete. */
  readonly lastGood = new Map<string, string>()
  /** Journey files that were never readable, by URI: a dimmed row in the list says why. */
  readonly invalid = new Map<string, { folder: vscode.WorkspaceFolder; uri: vscode.Uri; why: string }>()
  /** Checks' tours (by key), kept across a reload of the journeys folders, and the text each was made from. */
  private tours = new Map<string, LoadedJourney>()
  private tourText = new Map<string, string>()

  constructor(log: vscode.LogOutputChannel, state?: vscode.Memento) { super(log, state) }

  /** The journeys of the lists, lenses and search: never a check's tour (it is reached from the Check view). */
  all(): LoadedJourney[] { return [...this.list.values()].filter((x) => !x.check).sort((a, b) => a.j.title.localeCompare(b.j.title)) }
  byPos(key: string | undefined): LoadedJourney | undefined { return key ? [...this.list.values()].find((x) => posKey(x) === key) : undefined }

  /**
   * The tour of a check (its `journey`), shown and walked like a journey file; undefined removes it. Its id is made
   * per branch, so where it was left is kept per branch. Returns it (unchanged when the same tour is set again).
   */
  async setTour(folder: vscode.WorkspaceFolder, uri: vscode.Uri, raw: unknown, branch: string): Promise<LoadedJourney | undefined> {
    const key = `${uri.toString()}#tour`
    const prev = this.tours.get(key)
    if (!raw) { this.dropTour(key); return undefined }
    const text = JSON.stringify(raw)
    if (prev && this.tourText.get(key) === text && prev.check?.branch === branch) return prev
    const j = parseJourney(text, 'tour')
    if (typeof j === 'string') { this.log.warn(`check tour in ${uri.fsPath}: not shown: ${j}`); this.dropTour(key); return undefined }
    j.id = `check-${branch.replace(/[^\w.-]+/g, '-')}`
    const lj: LoadedJourney = { key, folder, uri, j, at: writtenAt(j), check: { branch } }
    if (prev) carryPositions(prev, lj)
    this.tourText.set(key, text)
    this.tours.set(key, lj)
    this.list.set(key, lj)
    await this.locate(lj)
    this.changed.fire()
    return lj
  }

  private dropTour(key: string): void {
    if (!this.tours.has(key)) return
    this.tours.delete(key)
    this.list.delete(key)
    this.changed.fire()
  }

  async load(): Promise<void> {
    this.list.clear()
    this.invalid.clear()
    for (const [k, lj] of this.tours) this.list.set(k, lj)
    for (const w of this.watchers) w.dispose()
    this.watchers = []
    const old: string[] = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // The repo's journeys first: a personal copy with the same id (the old place) is not listed twice.
      const dirs = [...new Set([journeysFolderName(), `${folderName()}/journeys`])]
      for (const rel of dirs) this.watch(folder, rel)
      for (const rel of dirs) {
        for (const uri of (await jsonFilesIn(vscode.Uri.joinPath(folder.uri, rel)))?.files ?? []) {
          const v1 = await this.read(folder, uri)
          if (v1) old.push(v1)
        }
      }
    }
    this.logOld(old)
    this.changed.fire()
  }

  /** Watches the journey files in `rel`, and `rel` itself: moved or deleted as a whole, no event per file comes. */
  private watch(folder: vscode.WorkspaceFolder, rel: string): void {
    const reread = (u: vscode.Uri) => this.read(folder, u).then((v1) => { if (v1) this.logOld([v1]); this.changed.fire() }, (e) => this.log.error(`journey ${u.fsPath}: ${e}`))
    const gone = (u: vscode.Uri) => { const a = this.list.delete(u.toString()), b = this.invalid.delete(u.toString()); if (a || b) this.changed.fire() }
    const files = watchJsonFiles(folder, rel, reread, gone)
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const dir = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, parent ? `{${parent},${rel}}` : rel), true, true, false)
    dir.onDidDelete(() => void this.prune())
    this.watchers.push(files, dir)
  }

  /** Drops journeys whose files are gone (moved away with their folder:). */
  private async prune(): Promise<void> {
    let gone = false
    for (const m of [this.list, this.invalid] as Map<string, { uri: vscode.Uri }>[]) for (const [k, x] of [...m]) {
      try { await wfs.stat(x.uri) } catch { m.delete(k); gone = true }
    }
    if (gone) this.changed.fire()
  }

  private logOld(names: string[]): void {
    if (names.length) this.log.info(`journeys in the old format (v1, steps as notes) not shown: ${names.join(', ')}; migrate them to v2`)
  }

  /** Reads one journey file again now (it was just rewritten), without waiting for the file watcher. */
  async reload(uri: vscode.Uri): Promise<LoadedJourney | undefined> {
    const f = vscode.workspace.getWorkspaceFolder(uri)
    if (!f) return undefined
    await this.read(f, uri)
    this.changed.fire()
    return this.list.get(uri.toString())
  }

  /** Reads one journey file; returns its name when it is in the old format (logged by the caller, once). */
  private async read(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<string | undefined> {
    const key = uri.toString()
    let raw: string
    try { raw = decoder.decode(await wfs.readFile(uri)) } catch { this.list.delete(key); this.invalid.delete(key); return undefined }
    const name = uri.path.split('/').pop()!.replace(/\.json$/, '')
    const j = parseJourney(raw, name)
    if (typeof j === 'string') return this.unreadable(folder, uri, name, j)
    this.lastGood.set(key, raw)
    this.invalid.delete(key)
    if (this.hiddenByTwin(folder, uri, j.id)) return undefined
    const prev = this.list.get(key)
    const lj: LoadedJourney = { key, folder, uri, j, at: writtenAt(j) }
    if (prev) carryPositions(prev, lj)
    this.restoreRenames(lj)
    this.list.set(key, lj)
    await this.locate(lj)
    return undefined
  }

  /** A journey file the parser refused (`why`): its name when it is in the old format. */
  private unreadable(folder: vscode.WorkspaceFolder, uri: vscode.Uri, name: string, why: string): string | undefined {
    const key = uri.toString()
    const prev = this.list.get(key)
    const old = isOldFormat(why)
    // Never readable: one dimmed row in the list says so; the parser's words are its tooltip.
    if (!prev) this.invalid.set(key, { folder, uri, why: old ? 'Old format (v1): migrate it with journey.py migrate.' : `Can't read it: ${why}.` })
    if (old) { this.list.delete(key); return name }
    // Half-written, most likely: keep the last good version, and say so on the map.
    this.log.warn(`journey ${uri.fsPath}: skipped: ${why}`)
    // One plain line for readers; the parser's words are in the Output panel.
    if (prev) prev.readError = "Can't read this journey's file; showing its last good version."
    return undefined
  }

  /**
   * The same journey in the repo's folder and in the notes folder (copied, or not yet moved): the repo's one wins.
   * True when it is `uri` that is not listed.
   */
  private hiddenByTwin(folder: vscode.WorkspaceFolder, uri: vscode.Uri, id: string): boolean {
    const twin = [...this.list.values()].find((x) => x.key !== uri.toString() && x.folder.uri.toString() === folder.uri.toString() && x.j.id === id)
    if (!twin) return false
    const legacy = this.isLegacy(folder, uri)
    if (legacy && !this.isLegacy(folder, twin.uri)) {
      this.log.info(`journey ${id}: ${uri.fsPath} not listed: ${twin.uri.fsPath} has the same id`)
      this.list.delete(uri.toString())
      return true
    }
    if (!legacy && this.isLegacy(folder, twin.uri)) {
      this.log.info(`journey ${id}: ${twin.uri.fsPath} not listed: ${uri.fsPath} has the same id`)
      this.list.delete(twin.key)
    }
    return false
  }

  /** A journey file in the notes folder (the old place), not the repo's journeys folder. */
  private isLegacy(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    return pathIn(vscode.Uri.joinPath(folder.uri, journeysFolderName()), uri) === undefined
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    this.changed.dispose()
    super.dispose()
  }
}
