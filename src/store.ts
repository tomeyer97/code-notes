import * as vscode from 'vscode'
import { wfs } from './wfs'
import * as fs from 'fs'
import * as path from 'path'
import { placeFile } from './paths'
import { fileName, jsonFilesIn, jsonName, readText, watchJsonFiles } from './jsonFolder'
import { NoteData, agentReadme, folderProblem, merge, parseNote, serialize, titleOf } from './noteModel'
import { SaveFailures } from './saveFailures'

// One JSON file per note in <workspace folder>/<codeNotes.folder>/<name>.json. One file per note so an agent and
// the extension never overwrite each other's notes. A note IS its file: the file name is its identity (an "id"
// field that disagrees is ignored). Deleted notes move to <folder>/.trash/. The format is documented in the README
// the extension writes into the folder (noteModel.ts agentReadme), which also names the person. What is in a note file
// (fields, parsing, merging) is noteModel.ts; this reads, watches and writes the files.

export interface Note {
  data: NoteData
  folder: vscode.WorkspaceFolder
  /** The note's file. */
  uri: vscode.Uri
  /** The file's content as last read or written: watcher events with this content are our own writes. */
  raw?: string
  /** The note as last read or written: the common ancestor when the file changed under us (merge). */
  base?: NoteData
}

/** A folder setting (`codeNotes.<key>`), trimmed; `fallback` when it is empty or can't be used (folderProblem). */
export function folderSetting(key: string, fallback: string): string {
  const v = vscode.workspace.getConfiguration('codeNotes').get<string>(key) || fallback
  return folderProblem(v) ? fallback : v.trim()
}

/** The notes folder (codeNotes.folder, default `.code-notes`), relative to the workspace folder. */
export function folderName(): string {
  return folderSetting('folder', '.code-notes').replace(/\/+$/, '')
}

const encoder = new TextEncoder()

export function notesDir(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, folderName())
}

/**
 * Writes a note file in one step (a hidden temp file, then a rename): an agent (or a test) reading it meanwhile sees
 * the old content or the new one, never a half-written file (the flaky "note history" test read a truncated file).
 */
let tmpSeq = 0
export async function writeAtomic(uri: vscode.Uri, text: string): Promise<void> {
  // One temp file per write: two saves of a note at once must not rename each other's file away.
  const tmp = vscode.Uri.joinPath(uri, '..', `.${fileName(uri)}.${process.pid}.${++tmpSeq}.tmp`)
  await wfs.writeFile(tmp, encoder.encode(text))
  // Node's rename replaces the file in one step; VS Code's rename with overwrite deletes it first (a moment with no file).
  try { if (uri.scheme === 'file') await fs.promises.rename(tmp.fsPath, uri.fsPath); else await wfs.rename(tmp, uri, { overwrite: true }) }
  catch (e) { try { await wfs.delete(tmp) } catch { /* gone */ } throw e }
}

/** Where a note file of `folder` goes when it is deleted (restore brings it back). */
const trashUri = (folder: vscode.WorkspaceFolder, uri: vscode.Uri) => vscode.Uri.joinPath(notesDir(folder), '.trash', fileName(uri))

/** A note with a file but no range and no target: a folder note, when its file is a folder (folderNoteShorthand). */
const isRangelessFileNote = (v: any) =>
  !!v && typeof v === 'object' && v.range === undefined && v.target === undefined && typeof v.file === 'string'

/** `uri` is a folder (false when it is missing). */
async function isFolder(uri: vscode.Uri): Promise<boolean> {
  try { return !!((await wfs.stat(uri)).type & vscode.FileType.Directory) } catch { return false }
}

export class Store implements vscode.Disposable {
  /** By note file URI. */
  readonly notes = new Map<string, Note>()
  /** Note files that could not be read: uri -> why (the last good version, if any, stays in `notes`). */
  readonly broken = new Map<string, string>()
  /** The first message of broken files that are JSON, so the list can say what the note was about. */
  readonly brokenTitle = new Map<string, string>()
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  /** A note file was deleted by someone else (an agent's rm): its last version was copied to.trash. */
  private readonly deletedOnDisk = new vscode.EventEmitter<Note>()
  readonly onDidDeleteOnDisk = this.deletedOnDisk.event
  private watchers: vscode.Disposable[] = []
  /** Saves that failed, said once each and together. */
  private readonly saveFailures: SaveFailures

  constructor(private log: vscode.LogOutputChannel, private person: () => string) {
    this.saveFailures = new SaveFailures(log, folderName)
  }

  get(id: string): Note | undefined {
    for (const n of this.notes.values()) if (n.data.id === id) return n
    return undefined
  }

  all(): Note[] { return [...this.notes.values()] }

  async load(): Promise<void> {
    this.notes.clear()
    this.broken.clear()
    for (const w of this.watchers) w.dispose()
    this.watchers = []
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // Relative to the workspace folder, not the notes folder: that one may not exist yet (first note).
      const reread = (u: vscode.Uri) => this.readFile(folder, u).then((c) => c && this.changed.fire())
      this.watchers.push(watchJsonFiles(folder, folderName(), reread, (u) => this.deletedFile(u)))
      const dir = await jsonFilesIn(notesDir(folder))
      if (!dir) continue
      for (const uri of dir.files) await this.readFile(folder, uri)
      if (dir.entries) await this.writeReadme(folder)
      this.log.appendLine(`${folder.name}: ${[...this.notes.values()].filter((n) => n.folder === folder).length} notes in ${folderName()}/${this.broken.size ? `, ${this.broken.size} unreadable` : ''}`)
    }
    this.changed.fire()
  }

  /** A note file deleted on disk. */
  private async deletedFile(u: vscode.Uri): Promise<void> {
    // A file replaced by a rename (our atomic save, an agent's tmp + mv) may be reported as deleted: it is there.
    try { await wfs.stat(u); return } catch { /* really gone */ }
    const n = this.notes.get(u.toString())
    if (!this.forget(u)) return
    // Not our own delete (trash forgets the note first): keep its last version in.trash so it can be restored.
    if (n?.raw && u.path.startsWith(notesDir(n.folder).path + '/')) {
      try { await wfs.writeFile(trashUri(n.folder, u), encoder.encode(n.raw)) } catch { /* best effort */ }
      this.log.appendLine(`${u.fsPath}: deleted on disk; the last version is in ${folderName()}/.trash`)
      this.deletedOnDisk.fire(n)
    }
    this.changed.fire()
  }

  /** Reads one note file; true if anything changed. */
  private async readFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<boolean> {
    // Dot files are not notes (`.request.json`: a script's request for the extension).
    if (jsonName(uri).startsWith('.')) return false
    const raw = await readText(uri)
    if (raw === undefined) return this.forget(uri)
    const key = uri.toString()
    const existing = this.notes.get(key)
    // A file that parses again (an agent finished its write, or it was restored) is no longer broken.
    const wasBroken = this.broken.delete(key)
    if (wasBroken) this.log.appendLine(`${uri.fsPath}: readable again`)
    if (existing && existing.raw === raw) return wasBroken
    const parsed = parseNote(await this.folderNoteShorthand(folder, raw), jsonName(uri))
    if (typeof parsed === 'string') return this.markBroken(uri, raw, parsed)
    const placed = placeFile(folder.uri.fsPath, parsed.file)
    if (typeof placed !== 'string') return this.markBroken(uri, raw, placed.error)
    if (placed !== parsed.file) this.log.appendLine(`note ${parsed.id}: path "${parsed.file}" read as "${placed}"`)
    parsed.file = placed
    const why = await this.targetProblem(folder, placed, parsed)
    if (why) return this.markBroken(uri, raw, why)
    this.brokenTitle.delete(key)
    this.notes.set(key, { data: parsed, folder, uri, raw, base: structuredClone(parsed) })
    return true
  }

  /** A note file that can't be used (`why`): half-written, most likely; the last good version stays. */
  private markBroken(uri: vscode.Uri, raw: string, why: string): true {
    const key = uri.toString()
    this.broken.set(key, why)
    const title = titleOf(raw)
    if (title) this.brokenTitle.set(key, title); else this.brokenTitle.delete(key)
    this.log.warn(`${uri.fsPath}: ${why}`)
    return true
  }

  /** `{ "file": "src/api", … }` with no range: a folder note, when that is a folder (agents leave "target" out). */
  private async folderNoteShorthand(folder: vscode.WorkspaceFolder, raw: string): Promise<string> {
    let v: any
    try { v = JSON.parse(raw) } catch { return raw }
    if (!isRangelessFileNote(v)) return raw
    const placed = placeFile(folder.uri.fsPath, v.file)
    if (typeof placed !== 'string') return raw
    if (!(await isFolder(vscode.Uri.joinPath(folder.uri, placed)))) return raw
    return JSON.stringify({ ...v, target: 'folder' })
  }

  /**
   * Why a note can't point at this path (through a symlink, something outside the workspace), or undefined. A note
   * whose "file" is a folder is a folder note; a "folder" note on a file is a file note.
   */
  private async targetProblem(folder: vscode.WorkspaceFolder, file: string, d: NoteData): Promise<string | undefined> {
    const uri = vscode.Uri.joinPath(folder.uri, file)
    try {
      const dir = !!((await wfs.stat(uri)).type & vscode.FileType.Directory)
      if (dir && d.target !== 'folder') { d.target = 'folder'; d.range = { start: 1, end: 1 }; d.anchor = { text: '', before: '', after: '' }; d.stale = false; delete d.selection }
      else if (!dir && d.target === 'folder') d.target = 'file'
    } catch { return undefined /* missing: shown as "file not found" */ }
    if (folder.uri.scheme !== 'file') return undefined
    try {
      const root = fs.realpathSync(folder.uri.fsPath)
      const real = fs.realpathSync(uri.fsPath)
      if (real !== root && !real.startsWith(root + path.sep)) return `"file" is outside this workspace (a link to ${real})`
    } catch { /* gone meanwhile */ }
    return undefined
  }

  private forget(uri: vscode.Uri): boolean {
    const a = this.broken.delete(uri.toString())
    const b = this.notes.delete(uri.toString())
    return a || b
  }

  /** A new note's file. */
  uriFor(folder: vscode.WorkspaceFolder, id: string): vscode.Uri { return vscode.Uri.joinPath(notesDir(folder), `${id}.json`) }

  /**
   * Writes a note. If its file changed since we read it (an agent appended a reply a moment ago), the change is
   * merged in rather than overwritten.
   */
  async save(n: Note): Promise<boolean> {
    if (serialize(n.data) === n.raw) return true
    let merged = false
    if (n.raw !== undefined) {
      // Undefined: deleted, write ours.
      const disk = await readText(n.uri)
      if (disk !== undefined && disk !== n.raw) {
        const theirs = parseNote(disk, n.data.id)
        if (typeof theirs === 'string') { this.log.appendLine(`${n.uri.fsPath}: not saved, the file is being written (${theirs})`); return false }
        n.data = merge(n.base ?? theirs, n.data, theirs)
        this.log.appendLine(`${n.uri.fsPath}: merged a change made on disk`)
        merged = true
      }
    }
    const raw = serialize(n.data)
    const key = n.uri.toString()
    try {
      await this.ensureFolder(n.folder)
      await writeAtomic(n.uri, raw)
    } catch (e) {
      this.saveFailures.report(n.uri, e as Error)
      return false
    }
    this.saveFailures.saved(n.uri)
    n.raw = raw
    n.base = structuredClone(n.data)
    this.notes.set(key, n)
    // Their change (a reply, a resolve) came in through our save, not the watcher: say so like the watcher would.
    if (merged) this.changed.fire()
    return true
  }

  /** Moves the note's file to <folder>/.trash/ (restore brings it back). */
  async trash(n: Note): Promise<void> {
    this.notes.delete(n.uri.toString())
    this.broken.delete(n.uri.toString())
    try { await wfs.rename(n.uri, trashUri(n.folder, n.uri), { overwrite: true }) } catch { /* already gone */ }
  }

  async restore(n: Note): Promise<void> {
    try { await wfs.rename(trashUri(n.folder, n.uri), n.uri, { overwrite: false }) } catch { await this.save({ ...n, raw: undefined }) }
    this.notes.set(n.uri.toString(), n)
  }

  async writeReadme(folder: vscode.WorkspaceFolder): Promise<void> {
    const u = vscode.Uri.joinPath(notesDir(folder), 'README.md')
    const want = agentReadme(this.person(), folderName())
    const have = (await readText(u)) ?? '' // none yet: ''
    if (have !== want) await wfs.writeFile(u, encoder.encode(want))
  }

  private async ensureFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const dir = notesDir(folder)
    // Only a folder Code Notes made (or already uses) gets a.gitignore: never someone else's folder (C116).
    let ours = true
    try {
      const entries = await wfs.readDirectory(dir)
      ours = entries.some(([n]) => n === 'README.md') || entries.every(([n]) => n.endsWith('.json'))
    } catch { /* new folder */ }
    try { await wfs.stat(vscode.Uri.joinPath(dir, 'README.md')) } catch { await this.writeReadme(folder) }
    const gi = vscode.Uri.joinPath(dir, '.gitignore')
    if (ours) try { await wfs.stat(gi) } catch { await this.writeGitignore(folder) }
  }

  /** Out of git: everything. Shared through git: still not the trash (deleted notes). */
  async writeGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
    const on = vscode.workspace.getConfiguration('codeNotes').get<boolean>('ignoreInGit', true)
    await wfs.writeFile(vscode.Uri.joinPath(notesDir(folder), '.gitignore'), encoder.encode(on ? '*\n' : '.trash/\n'))
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    this.changed.dispose()
    this.deletedOnDisk.dispose()
  }
}
