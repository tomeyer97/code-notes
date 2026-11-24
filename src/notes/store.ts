import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { wfs } from '../platform/workspaceFs'
import { placeFile } from '../core/paths'
import { fileName, jsonFilesIn, jsonName, readText, watchJsonFiles } from '../platform/jsonFolder'
import { NoteData, merge, parseNote, serialize, titleOf } from '../core/format/noteModel'
import { SaveFailures } from '../platform/saveFailures'
import { exists, notFound, statOf } from '../platform/exists'
import { report } from '../platform/run'
import { folderName, notesDir, setUpFolder, trashUri, writeReadme } from './notesFolder'
import { fitTarget, isRangelessFileNote } from './model/target'
import type { NotesChange } from './model/changes'

// One JSON file per note in <workspace folder>/<codeNotes.folder>/<name>.json. One file per note so an agent and
// the extension never overwrite each other's notes. A note IS its file: its id is the file's name (an "id" field
// that disagrees is ignored), and the store keeps notes by file URI with an index by id. Deleted notes move to
// <folder>/.trash/. What is in a note file (fields, parsing, merging) is core/format/noteModel.ts; the notes folder
// (README, .gitignore, trash) is notesFolder.ts; this reads, watches and writes the files, and says what changed.

export interface Note {
  data: NoteData
  folder: vscode.WorkspaceFolder
  /** The note's file. */
  uri: vscode.Uri
  /** The file's content as last read or written: watcher events with this content are our own writes. */
  raw?: string
  /** The note as last read or written: the common ancestor when the file changed under us (merge), and what a change
   *  on disk is compared with (changedOnDisk.ts). */
  base?: NoteData
}

/** A note file that can't be used: why, and its first message when it is JSON (so the list can say what it was about). */
export interface BrokenFile { uri: string; why: string; title?: string }

/** Note files someone else changed: each note read, with what it was before (none: a new note). A file that went, or
 *  became readable or not, is in no list: the change still comes. */
export interface DiskChange { notes: { note: Note; before?: NoteData }[]; loaded?: boolean }

/** What reading a note file changed: the note read (none: the file went, or is broken now, or readable again), and
 *  what it was before. */
type FileRead = { note?: Note; before?: NoteData }

/**
 * Writes a note file in one step (a hidden temp file, then a rename): an agent (or a test) reading it meanwhile sees
 * the old content or the new one, never a half-written file (the flaky "note history" test read a truncated file).
 */
let tmpSeq = 0
const encoder = new TextEncoder()
export async function writeAtomic(uri: vscode.Uri, text: string): Promise<void> {
  // One temp file per write: two saves of a note at once must not rename each other's file away.
  const tmp = vscode.Uri.joinPath(uri, '..', `.${fileName(uri)}.${process.pid}.${++tmpSeq}.tmp`)
  await wfs.writeFile(tmp, encoder.encode(text))
  // Node's rename replaces the file in one step; VS Code's rename with overwrite deletes it first (a moment with no file).
  try { if (uri.scheme === 'file') await fs.promises.rename(tmp.fsPath, uri.fsPath); else await wfs.rename(tmp, uri, { overwrite: true }) }
  catch (e) { await wfs.remove(tmp).catch(() => undefined /* never written */); throw e }
}

/** A file's real path (links followed); undefined when it is gone. */
const realPath = (p: string) => fs.promises.realpath(p).catch(() => undefined)

export class Store implements vscode.Disposable {
  /** By note file URI. */
  private readonly files = new Map<string, Note>()
  /** By note id (the file name): the first file read with that id. */
  private readonly ids = new Map<string, Note>()
  /** Note files that could not be read, by URI (the last good version, if any, stays in `files`). */
  private readonly brokenFiles = new Map<string, BrokenFile>()
  private readonly changed = new vscode.EventEmitter<NotesChange>()
  /** The extension changed notes: saved, trashed or restored, or all read again. */
  readonly onDidChange = this.changed.event
  private readonly disk = new vscode.EventEmitter<DiskChange>()
  /** Note files changed by someone else (read again, merged in by a save, gone, unreadable): changedOnDisk.ts. */
  readonly onDidChangeOnDisk = this.disk.event
  /** A note file was deleted by someone else (an agent's rm): its last version was copied to.trash. */
  private readonly deletedOnDisk = new vscode.EventEmitter<Note>()
  readonly onDidDeleteOnDisk = this.deletedOnDisk.event
  private watchers: vscode.Disposable[] = []
  /** Saves that failed, said once each and together. */
  private readonly saveFailures: SaveFailures

  constructor(private log: vscode.LogOutputChannel, private person: () => string) {
    this.saveFailures = new SaveFailures(log, folderName)
  }

  get(id: string): Note | undefined { return this.ids.get(id) }

  /** The note read from this file (by URI string), if any. */
  atUri(uri: string): Note | undefined { return this.files.get(uri) }

  all(): Note[] { return [...this.files.values()] }

  broken(): BrokenFile[] { return [...this.brokenFiles.values()] }
  brokenCount(): number { return this.brokenFiles.size }
  brokenAt(uri: string): BrokenFile | undefined { return this.brokenFiles.get(uri) }

  private put(n: Note): void {
    this.files.set(n.uri.toString(), n)
    const had = this.ids.get(n.data.id)
    if (!had || had.uri.toString() === n.uri.toString()) this.ids.set(n.data.id, n)
  }

  private drop(uri: vscode.Uri): boolean {
    const key = uri.toString()
    const n = this.files.get(key)
    if (!n) return false
    this.files.delete(key)
    if (this.ids.get(n.data.id) === n) {
      this.ids.delete(n.data.id)
      // Another folder's note with the same id takes its place.
      const other = [...this.files.values()].find((x) => x.data.id === n.data.id)
      if (other) this.ids.set(other.data.id, other)
    }
    return true
  }

  async load(): Promise<void> {
    const was = new Map([...this.files].map(([k, n]) => [k, n.base]))
    this.files.clear()
    this.ids.clear()
    this.brokenFiles.clear()
    for (const w of this.watchers) w.dispose()
    this.watchers = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // Relative to the workspace folder, not the notes folder: that one may not exist yet (first note).
      const reread = async (u: vscode.Uri) => {
        const c = await this.readFile(folder, u)
        if (c) this.disk.fire({ notes: c.note ? [{ note: c.note, before: c.before }] : [] })
      }
      this.watchers.push(watchJsonFiles(folder, folderName(), reread, (u) => this.deletedFile(u)))
      const dir = await jsonFilesIn(notesDir(folder))
      if (!dir) continue
      for (const uri of dir.files) await this.readFile(folder, uri)
      if (dir.entries) await this.writeReadme(folder)
      const count = this.all().filter((n) => n.folder === folder).length
      this.log.appendLine(`${folder.name}: ${count} notes in ${folderName()}/${this.brokenFiles.size ? `, ${this.brokenFiles.size} unreadable` : ''}`)
    }
    this.disk.fire({ loaded: true, notes: this.all().map((note) => ({ note, before: was.get(note.uri.toString()) })) })
    this.changed.fire({ kind: 'loaded' })
  }

  /** A note file deleted on disk. */
  private async deletedFile(u: vscode.Uri): Promise<void> {
    // A file replaced by a rename (our atomic save, an agent's tmp + mv) may be reported as deleted: it is there.
    if (await exists(u)) return
    const n = this.files.get(u.toString())
    if (!this.forget(u)) return
    // Not our own delete (trash forgets the note first): keep its last version in.trash so it can be restored.
    if (n?.raw && u.path.startsWith(notesDir(n.folder).path + '/')) {
      await wfs.writeFile(trashUri(n.folder, u), encoder.encode(n.raw)).catch((e) => report(e, { what: `keeping ${u.fsPath} in the trash` }))
      this.log.appendLine(`${u.fsPath}: deleted on disk; the last version is in ${folderName()}/.trash`)
      this.deletedOnDisk.fire(n)
    }
    this.disk.fire({ notes: [] })
  }

  /** Reads one note file; what changed (undefined: nothing). `note`: the note read, `before`: what it was. */
  private async readFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<FileRead | undefined> {
    // Dot files are not notes (`.request.json`: a script's request for the extension).
    if (jsonName(uri).startsWith('.')) return undefined
    const raw = await readText(uri)
    if (raw === undefined) return this.forget(uri) ? {} : undefined
    const key = uri.toString()
    const existing = this.files.get(key)
    // A file that parses again (an agent finished its write, or it was restored) is no longer broken.
    const wasBroken = this.brokenFiles.delete(key)
    if (wasBroken) this.log.appendLine(`${uri.fsPath}: readable again`)
    if (existing && existing.raw === raw) return wasBroken ? {} : undefined
    const read = parseNote(await this.folderNoteShorthand(folder, raw), jsonName(uri))
    if (!read.ok) return this.markBroken(uri, raw, read.why)
    const placed = placeFile(folder.uri.fsPath, read.value.file)
    if (typeof placed !== 'string') return this.markBroken(uri, raw, placed.error)
    if (placed !== read.value.file) this.log.appendLine(`note ${read.value.id}: path "${read.value.file}" read as "${placed}"`)
    const target = vscode.Uri.joinPath(folder.uri, placed)
    const st = await statOf(target)
    // Missing: kept as it is, shown as "file not found".
    const data = st ? fitTarget({ ...read.value, file: placed }, !!(st.type & vscode.FileType.Directory)) : { ...read.value, file: placed }
    const outside = st ? await this.outsideWorkspace(folder, target) : undefined
    if (outside) return this.markBroken(uri, raw, outside)
    const note: Note = { data, folder, uri, raw, base: structuredClone(data) }
    this.put(note)
    return { note, before: existing?.base }
  }

  /** A note file that can't be used (`why`): half-written, most likely; the last good version stays. */
  private markBroken(uri: vscode.Uri, raw: string, why: string): FileRead {
    const key = uri.toString()
    const title = titleOf(raw)
    this.brokenFiles.set(key, { uri: key, why, ...(title ? { title } : {}) })
    this.log.warn(`${uri.fsPath}: ${why}`)
    return {}
  }

  /** The folder-note shorthand (model/target.ts) as the format has it: `"target": "folder"` added when "file" is a
   *  folder. */
  private async folderNoteShorthand(folder: vscode.WorkspaceFolder, raw: string): Promise<string> {
    let v: unknown
    try { v = JSON.parse(raw) } catch { return raw /* parseNote says why */ }
    if (!isRangelessFileNote(v)) return raw
    const placed = placeFile(folder.uri.fsPath, v.file)
    if (typeof placed !== 'string') return raw
    const st = await statOf(vscode.Uri.joinPath(folder.uri, placed))
    if (!st || !(st.type & vscode.FileType.Directory)) return raw
    return JSON.stringify({ ...v, target: 'folder' })
  }

  /** Why a note can't point at `target`: through a link, it is outside the workspace; else undefined. */
  private async outsideWorkspace(folder: vscode.WorkspaceFolder, target: vscode.Uri): Promise<string | undefined> {
    if (folder.uri.scheme !== 'file') return undefined
    const root = await realPath(folder.uri.fsPath)
    const real = await realPath(target.fsPath)
    if (!root || !real) return undefined // gone meanwhile
    return real !== root && !real.startsWith(root + path.sep) ? `"file" is outside this workspace (a link to ${real})` : undefined
  }

  private forget(uri: vscode.Uri): boolean {
    const a = this.brokenFiles.delete(uri.toString())
    const b = this.drop(uri)
    return a || b
  }

  /** A new note's file. */
  uriFor(folder: vscode.WorkspaceFolder, id: string): vscode.Uri { return vscode.Uri.joinPath(notesDir(folder), `${id}.json`) }

  /**
   * Writes a note. If its file changed since we read it (an agent appended a reply a moment ago), the change is
   * merged in rather than overwritten. False when it could not be written (the failure is said).
   */
  async save(n: Note): Promise<boolean> {
    if (serialize(n.data) === n.raw) return true
    const before = n.base
    let merged = false
    if (n.raw !== undefined) {
      // Undefined: deleted, write ours.
      const disk = await readText(n.uri)
      if (disk !== undefined && disk !== n.raw) {
        const read = parseNote(disk, n.data.id)
        if (!read.ok) { this.log.appendLine(`${n.uri.fsPath}: not saved, the file is being written (${read.why})`); return false }
        const theirs = read.value
        n.data = merge(n.base ?? theirs, n.data, theirs)
        this.log.appendLine(`${n.uri.fsPath}: merged a change made on disk`)
        merged = true
      }
    }
    const raw = serialize(n.data)
    try {
      await setUpFolder(n.folder, this.person())
      await writeAtomic(n.uri, raw)
    } catch (e) {
      this.saveFailures.report(n.uri, e as Error)
      return false
    }
    this.saveFailures.saved(n.uri)
    n.raw = raw
    n.base = structuredClone(n.data)
    this.put(n)
    // Their change (a reply, a resolve) came in through our save, not the watcher: said as the watcher would.
    if (merged) this.disk.fire({ notes: [{ note: n, before }] })
    this.changed.fire({ kind: 'saved', ids: [n.data.id] })
    return true
  }

  /** Moves the note's file to <folder>/.trash/ (restore brings it back). */
  async trash(n: Note): Promise<void> {
    this.forget(n.uri)
    try { await wfs.rename(n.uri, trashUri(n.folder, n.uri), { overwrite: true }) } catch (e) {
      if (!notFound(e)) report(e, { what: `moving ${n.uri.fsPath} to the trash` }) // not found: already gone
    }
    this.changed.fire({ kind: 'removed', ids: [n.data.id] })
  }

  /** Brings a trashed note back: its file from the trash, else (not there, or a file is in its place) written again
   *  from memory. */
  async restore(n: Note): Promise<void> {
    if (!(await this.fromTrash(n))) await this.save({ ...n, raw: undefined })
    this.put(n)
    this.changed.fire({ kind: 'removed', ids: [n.data.id] })
  }

  /** The note's file renamed back from the trash; false when that can't be done. */
  private async fromTrash(n: Note): Promise<boolean> {
    try { await wfs.rename(trashUri(n.folder, n.uri), n.uri, { overwrite: false }); return true } catch (e) {
      const expected = notFound(e) || (e instanceof vscode.FileSystemError && e.code === 'FileExists')
      if (!expected) report(e, { what: `restoring ${n.uri.fsPath} from the trash` })
      return false
    }
  }

  /** The README for agents, naming the person. */
  writeReadme(folder: vscode.WorkspaceFolder): Promise<void> { return writeReadme(folder, this.person()) }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    this.changed.dispose()
    this.disk.dispose()
    this.deletedOnDisk.dispose()
  }
}
