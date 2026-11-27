import * as vscode from 'vscode'
import { wfs } from '../platform/workspaceFs'
import { parseJourney } from '../core/format/journeyModel'
import { folderName, folderSetting } from '../notes/notesFolder'
import { jsonFilesIn, jsonName, readText, watchJsonFiles } from '../platform/jsonFolder'
import { LoadedJourney, carryPositions, writtenAt } from './steps'
import { pathIn, settingFolder } from '../core/paths'
import { isPodcastFile } from '../core/format/podcast/model'
import { fireAndForget } from '../platform/run'
import { SHOWING_LAST_GOOD, classifyUnreadable, invalidRow } from './fileStates'

// Journeys (format v2, docs/journey-format.md): <repo>/journeys/<slug>.json (codeNotes.journeys.folder: committed,
// shared) and, as before, <notes folder>/journeys/<slug>.json (personal); steps embedded. A step is not a note. This
// reads and watches the files; where the steps are as the code changes is the step locator's (stepLocator.ts).

/** Where journeys are committed (codeNotes.journeys.folder, default `journeys`), relative to the workspace folder. */
export function journeysFolderName(): string {
  return settingFolder(folderSetting('journeys.folder', 'journeys'))
}

/** A journey file that was never readable: a dimmed row in the list says why. */
export interface InvalidJourney { folder: vscode.WorkspaceFolder; uri: vscode.Uri; why: string }

export interface RepositoryPorts {
  /** A journey read just now: its steps are to be found in the code (the step locator's `track`). */
  track(lj: LoadedJourney): Promise<void>
  /** The files or what was read of them changed. */
  changed(): void
  log: vscode.LogOutputChannel
}

/** The journey files of the workspace folders, by URI. */
export class JourneyRepository implements vscode.Disposable {
  private readonly files = new Map<string, LoadedJourney>()
  private readonly broken = new Map<string, InvalidJourney>()
  /** The text each listed journey was read from: Restore writes it back. Kept as long as the journey is. */
  private readonly textOf = new WeakMap<LoadedJourney, string>()
  /** The last text of journey files deleted (or gone with their folder) this session, by URI: Restore after a delete. */
  private readonly deletedText = new Map<string, string>()
  private watchers: vscode.Disposable[] = []

  constructor(private readonly ports: RepositoryPorts) {}

  get(key: string): LoadedJourney | undefined { return this.files.get(key) }
  values(): IterableIterator<LoadedJourney> { return this.files.values() }
  /** Read-only views of the listed journeys and of the files never readable, by URI. */
  get listed(): ReadonlyMap<string, LoadedJourney> { return this.files }
  get invalid(): ReadonlyMap<string, InvalidJourney> { return this.broken }

  /** The text a journey was last read from (its file may be unreadable or deleted now). */
  lastGoodText(lj: LoadedJourney): string | undefined {
    return this.textOf.get(lj) ?? this.deletedText.get(lj.key)
  }

  /** The text the journey file `key` (its URI) was last read from: listed now, or deleted. */
  lastGoodTextOf(key: string): string | undefined {
    const lj = this.files.get(key)
    return (lj && this.textOf.get(lj)) ?? this.deletedText.get(key)
  }

  /** Writes a journey's last good text back to its file; false when there is none. */
  async restoreLastGood(lj: LoadedJourney): Promise<boolean> {
    const raw = this.lastGoodText(lj)
    if (!raw) return false
    await wfs.writeFile(lj.uri, new TextEncoder().encode(raw))
    return true
  }

  /** Reads every journey file again (all at once), and watches their folders. */
  async load(): Promise<void> {
    this.files.clear()
    this.broken.clear()
    this.watchAll()
    const found = (await Promise.all(this.journeyFiles())).flatMap(({ folder, uris }) => uris.map((uri) => ({ folder, uri })))
    const oldFormat = await Promise.all(found.map(({ folder, uri }) => this.read(folder, uri)))
    this.keepOrder(found.map(({ uri }) => uri.toString()))
    this.logOldFormat(oldFormat.filter((name): name is string => !!name))
    this.ports.changed()
  }

  /** The listed journeys in the order of `keys` (as found, not as their reads ended); any others after them. */
  private keepOrder(keys: string[]): void {
    const first = keys.flatMap((k) => this.files.get(k) ?? [])
    const rest = [...this.files.values()].filter((lj) => !first.includes(lj))
    this.files.clear()
    for (const lj of [...first, ...rest]) this.files.set(lj.key, lj)
  }

  /** The folders journeys are read from, in each workspace folder: the repo's first, then the notes folder's. */
  private dirsIn(): string[] {
    return [...new Set([journeysFolderName(), `${folderName()}/journeys`])]
  }

  private watchAll(): void {
    for (const w of this.watchers) w.dispose()
    this.watchers = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const rel of this.dirsIn()) this.watch(folder, rel)
    }
  }

  /** The journey files of every workspace folder (the repo's journeys first: a personal copy with its id is not
   *  listed twice, hiddenByTwin). */
  private journeyFiles(): Promise<{ folder: vscode.WorkspaceFolder; uris: vscode.Uri[] }>[] {
    const out: Promise<{ folder: vscode.WorkspaceFolder; uris: vscode.Uri[] }>[] = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const rel of this.dirsIn()) {
        const uris = jsonFilesIn(vscode.Uri.joinPath(folder.uri, rel)).then((x) => x?.files ?? [])
        out.push(uris.then((u) => ({ folder, uris: u })))
      }
    }
    return out
  }

  /** Watches the journey files in `rel`, and `rel` itself: moved or deleted as a whole, no event per file comes. */
  private watch(folder: vscode.WorkspaceFolder, rel: string): void {
    const files = watchJsonFiles(folder, rel, (u) => this.reread(folder, u), (u) => this.gone(u))
    // The folder and its parent: deleting either takes the files with it.
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const glob = parent ? `{${parent},${rel}}` : rel
    const dir = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob), true, true, false)
    dir.onDidDelete(() => fireAndForget(this.prune(), 'journeys: prune'))
    this.watchers.push(files, dir)
  }

  /** A journey file created or changed. */
  private reread(folder: vscode.WorkspaceFolder, u: vscode.Uri): Promise<void> {
    const done = (name: string | undefined) => {
      if (name) this.logOldFormat([name])
      this.ports.changed()
    }
    return this.read(folder, u).then(done, (e) => this.ports.log.error(`journey ${u.fsPath}: ${e}`))
  }

  /** A journey file deleted. */
  private gone(u: vscode.Uri): void {
    if (isPodcastFile(u.path)) {
      this.ports.changed()
      return
    }
    const listed = this.drop(u.toString())
    const invalid = this.broken.delete(u.toString())
    if (listed || invalid) this.ports.changed()
  }

  /** A listed journey whose file is gone: no longer listed, its text kept for Restore. */
  private drop(key: string): boolean {
    const lj = this.files.get(key)
    if (!lj) return false
    const text = this.textOf.get(lj)
    if (text !== undefined) this.deletedText.set(key, text)
    return this.files.delete(key)
  }

  /** Drops journeys whose files are gone (moved away with their folder). */
  private async prune(): Promise<void> {
    const listed = await this.pruneMissing(this.files, (k) => this.drop(k))
    const invalid = await this.pruneMissing(this.broken, (k) => this.broken.delete(k))
    if (listed || invalid) this.ports.changed()
  }

  /** The entries of `map` whose files are gone, dropped with `drop`; true when there were any. */
  private async pruneMissing(map: ReadonlyMap<string, { uri: vscode.Uri }>, drop: (key: string) => void): Promise<boolean> {
    let gone = false
    for (const [k, x] of [...map]) {
      const missing = await wfs.stat(x.uri).then(() => false, () => true)
      if (!missing) continue
      drop(k)
      gone = true
    }
    return gone
  }

  private logOldFormat(names: string[]): void {
    if (names.length) this.ports.log.info(`journeys in the old format (v1, steps as notes) not shown: ${names.join(', ')}; migrate them to v2`)
  }

  /** Reads one journey file again now (it was just rewritten), without waiting for the file watcher. */
  async reload(uri: vscode.Uri): Promise<LoadedJourney | undefined> {
    const f = vscode.workspace.getWorkspaceFolder(uri)
    if (!f) return undefined
    await this.read(f, uri)
    this.ports.changed()
    return this.files.get(uri.toString())
  }

  /** Reads one journey file; returns its name when it is in the old format (logged by the caller, once). */
  private async read(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<string | undefined> {
    // A journey's podcast (src/podcast/) is next to it, not a journey; a change to it still fires onDidChange.
    if (isPodcastFile(uri.path)) return undefined
    const key = uri.toString()
    const raw = await readText(uri)
    if (raw === undefined) {
      this.drop(key)
      this.broken.delete(key)
      return undefined
    }
    const name = jsonName(uri)
    const parsed = parseJourney(raw, name)
    if (!parsed.ok) return this.unreadable(folder, uri, name, parsed.why)
    const j = parsed.value
    this.broken.delete(key)
    this.deletedText.delete(key)
    if (this.hiddenByTwin(folder, uri, j.id)) return undefined
    const prev = this.files.get(key)
    const lj: LoadedJourney = { key, folder, uri, j, at: writtenAt(j) }
    if (prev) carryPositions(prev, lj)
    this.textOf.set(lj, raw)
    this.files.set(key, lj)
    await this.ports.track(lj)
    return undefined
  }

  /** A journey file the parser refused (`why`): what that means for the list. Its name when it is in the old format. */
  private unreadable(folder: vscode.WorkspaceFolder, uri: vscode.Uri, name: string, why: string): string | undefined {
    const key = uri.toString()
    const kind = classifyUnreadable(why)
    const prev = this.files.get(key)
    // Never readable: one dimmed row in the list says so; the parser's words are its tooltip.
    if (!prev) this.broken.set(key, { folder, uri, why: invalidRow(kind, why) })
    if (kind === 'oldFormat') {
      this.drop(key)
      return name
    }
    this.ports.log.warn(`journey ${uri.fsPath}: skipped: ${why}`)
    // Half-written, most likely: the last good version stays listed (the map and the list hold it), and says so.
    if (prev) prev.readError = SHOWING_LAST_GOOD
    return undefined
  }

  /**
   * The same journey in the repo's folder and in the notes folder (copied, or not yet moved): the repo's one wins.
   * True when it is `uri` that is not listed.
   */
  private hiddenByTwin(folder: vscode.WorkspaceFolder, uri: vscode.Uri, id: string): boolean {
    const sameFolder = (x: LoadedJourney) => x.folder.uri.toString() === folder.uri.toString()
    const twin = [...this.files.values()].find((x) => x.key !== uri.toString() && sameFolder(x) && x.j.id === id)
    if (!twin) return false
    const inNotes = this.inNotesFolder(folder, uri)
    const twinInNotes = this.inNotesFolder(folder, twin.uri)
    if (inNotes && !twinInNotes) {
      this.ports.log.info(`journey ${id}: ${uri.fsPath} not listed: ${twin.uri.fsPath} has the same id`)
      this.files.delete(uri.toString())
      return true
    }
    if (!inNotes && twinInNotes) {
      this.ports.log.info(`journey ${id}: ${twin.uri.fsPath} not listed: ${uri.fsPath} has the same id`)
      this.files.delete(twin.key)
    }
    return false
  }

  /** A journey file in the notes folder (where journeys used to be), not the repo's journeys folder. */
  private inNotesFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    return pathIn(vscode.Uri.joinPath(folder.uri, journeysFolderName()), uri) === undefined
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
  }
}
