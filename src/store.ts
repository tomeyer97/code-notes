import * as vscode from 'vscode'
import { wfs } from './wfs'
import * as fs from 'fs'
import * as path from 'path'
import { placeFile } from './paths'
import { jsonFilesIn, watchJsonFiles } from './jsonFolder'
import { NoteData, folderProblem, merge, parseNote, serialize, titleOf } from './noteModel'

// One JSON file per note in <workspace folder>/<codeNotes.folder>/<name>.json. One file per note so an agent and
// the extension never overwrite each other's notes. A note IS its file: the file name is its identity (an "id"
// field that disagrees is ignored). Deleted notes move to <folder>/.trash/. The format is documented in the README
// the extension writes into the folder (agentReadme below), which also names the person. What is in a note file
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

export function folderName(): string {
  const v = vscode.workspace.getConfiguration('codeNotes').get<string>('folder') || '.code-notes'
  return folderProblem(v) ? '.code-notes' : v.trim().replace(/\/+$/, '')
}

export function agentReadme(person: string): string {
  return `# Code notes

Notes **${person}** left on the code in this folder, one JSON file per note. The VS Code extension "Code Notes" shows
them as comment threads and lists them in its sidebar. Agents answer and resolve them by editing these files; the
extension picks changes up live and shows new messages to ${person} as unread.

## Format

\`\`\`json
{
  "id": "20261111-153012-ab12",
  "file": "src/main.ts",
  "range": { "start": 33, "end": 40 },
  "anchor": { "text": "  const token = readToken()", "before": "export function main() {", "after": "  use(token)" },
  "status": "open",
  "stale": false,
  "createdAt": "2026-11-11T15:30:12.000Z",
  "messages": [
    { "author": "${person}", "role": "human", "body": "Why is the token never removed?", "at": "2026-11-11T15:30:12.000Z" }
  ]
}
\`\`\`

| Field | Meaning |
|---|---|
| file name | The note's identity: \`<id>.json\`. Keep it when you edit a note. |
| \`file\` | The code file, relative to the folder that contains \`${folderName()}/\` (e.g. \`src/main.ts\`). Files outside that folder are refused. |
| \`range\` | Lines in \`file\`, 1-based, inclusive. |
| \`anchor\` | The lines the note is about (\`text\`), the lines around them, and the git \`branch\`/\`commit\` it was written on. The extension uses them to follow the code. |
| \`session\` | Optional: a name that groups notes (e.g. \`Review: render.go\`). The sidebar groups by session; a session can be hidden, resolved or deleted as a whole. |
| \`selection\` | Optional, when the note is about part of a line: \`{ "text": "readToken", "startCol": 8, "endCol": 17 }\` (0-based columns on the first line of \`range\`). A plain string is accepted as the text. |
| \`status\` | \`open\` or \`resolved\`. |
| \`stale\` | \`true\`: the code at \`range\` changed since the note was written; \`anchor.text\` is what it was about. |
| \`messages\` | The conversation, oldest first. \`role\` is \`human\` (${person}) or \`agent\`. |
| \`severity\` | Optional, for review findings: \`high\`, \`medium\`, \`low\` or \`nit\`. The sidebar shows an icon and lists the most severe first. |
| \`target\` | Optional: \`"file"\` for a note on a whole file, \`"folder"\` for a folder (\`file\` is then the folder, e.g. \`src/api\`). No \`range\` or \`anchor\`. |
| \`journey\` | Set on a question asked from a journey step: \`{ "id": "<journey id>", "step": "<step id>", "n": <its number then> }\`. The step is \`step\` in \`<notes folder>/journeys/<id>.json\` (find it by id: numbers change). |
| \`events\` | Status changes, oldest first: \`{ "type": "resolved" \\| "reopened", "by": "<name>", "role": "agent", "at": "<ISO 8601>" }\`. |

A note on a whole file or folder:

\`\`\`json
{ "file": "src/api", "target": "folder", "status": "open", "messages": [{ "author": "claude", "role": "agent", "body": "This folder mixes HTTP and storage code." }] }
\`\`\`

## For agents

- **Which notes need an answer:** \`status\` is \`open\` and the last message has \`"role": "human"\`.
- **Answer:** append \`{ "author": "<your name>", "role": "agent", "body": "<markdown>", "at": "<ISO 8601 now>" }\`
  to \`messages\`. Keep every other field as it is.
- **Read the code** at \`file\` / \`range\` first. If \`stale\` is true, the code changed: \`anchor.text\` is what the note was about.
- **Resolve** (only when asked): set \`"status": "resolved"\` and append \`{ "type": "resolved", "by": "<your name>", "role": "agent", "at": "<now>" }\`
  to \`events\`, in the same write as your last message if you add one. A reply on a resolved note reopens it.
- **Create a note** for ${person}: write \`<id>.json\` (id \`YYYYMMDD-HHMMSS-xxxx\`: the current time and 4 random
  letters, so many notes written in one second don't collide) with \`file\`, \`range\`, \`"status": "open"\` and one message
  with \`"role": "agent"\`. Leave \`anchor\` out: the extension fills it from the code at \`range\`.
- **A question from a journey step** (\`journey\` is set): answer about that step (its code is at the step's
  \`file\`/\`range\` in the journey file). A note starting "This step is out of date" asks you to fix the step itself
  (the code-journey skill's \`journey.py\`), then reply saying what you changed and resolve the note.
- **A review** (several findings): one note per finding, all with the same \`session\` (e.g. \`"Security review"\`)
  and a \`severity\`. The first line of the message is the note's title in the list: make it a one-sentence summary.
- **Suggest a fix:** a fenced block with the language \`suggestion\` holds the replacement for the note's lines
  (all of \`range\`, whole lines). ${person} gets an Apply button; nothing changes until they press it.
  \`\`\`\`
  \`\`\`suggestion
    const token = readToken()
    defer clear(token)
  \`\`\`
  \`\`\`\`
- **Link code** as \`path:line\` or \`[text](path#L12)\`: the thread turns them into links.
- **You changed the code a note points at** (moved or rewrote it): update \`file\` and \`range\` to where the code is now
  and set \`anchor\` to \`{}\`; the extension refills it from the new lines and clears \`stale\`. Leave other notes alone:
  the extension follows code that moved by itself.
- **Never delete note files**: resolve them. ${person} deletes notes.
- Write complete, valid JSON (no comments): write \`<id>.json.tmp\`, then rename it to \`<id>.json\`.
`
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Where journeys are committed (codeNotes.journeys.folder, default `journeys`), relative to the workspace folder. */
export function journeysFolderName(): string {
  const v = vscode.workspace.getConfiguration('codeNotes').get<string>('journeys.folder') || 'journeys'
  return folderProblem(v) ? 'journeys' : v.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '')
}

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
  const tmp = vscode.Uri.joinPath(uri, '..', `.${uri.path.split('/').pop()}.${process.pid}.${++tmpSeq}.tmp`)
  await wfs.writeFile(tmp, encoder.encode(text))
  // Node's rename replaces the file in one step; VS Code's rename with overwrite deletes it first (a moment with no file).
  try { if (uri.scheme === 'file') await fs.promises.rename(tmp.fsPath, uri.fsPath); else await wfs.rename(tmp, uri, { overwrite: true }) }
  catch (e) { try { await wfs.delete(tmp) } catch { /* gone */ } throw e }
}

const baseName = (uri: vscode.Uri) => uri.path.split('/').pop()!.replace(/\.json$/, '')

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
  /** Files a save failed for (reported once until a save works again). */
  private readonly failed = new Set<string>()
  /** Failures not shown yet: one message for those of the next half second. */
  private failNames: string[] = []
  private failWhy = ""
  private failTimer: ReturnType<typeof setTimeout> | undefined
  private watchers: vscode.Disposable[] = []

  constructor(private log: vscode.LogOutputChannel, private person: () => string) {}

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
      try { await wfs.writeFile(vscode.Uri.joinPath(notesDir(n.folder), '.trash', u.path.split('/').pop()!), encoder.encode(n.raw)) } catch { /* best effort */ }
      this.log.appendLine(`${u.fsPath}: deleted on disk; the last version is in ${folderName()}/.trash`)
      this.deletedOnDisk.fire(n)
    }
    this.changed.fire()
  }

  /** Reads one note file; true if anything changed. */
  private async readFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<boolean> {
    // Dot files are not notes (`.request.json`: a script's request for the extension).
    if (baseName(uri).startsWith('.')) return false
    let raw: string
    try { raw = decoder.decode(await wfs.readFile(uri)) } catch { return this.forget(uri) }
    const key = uri.toString()
    const existing = this.notes.get(key)
    // A file that parses again (an agent finished its write, or it was restored) is no longer broken.
    const wasBroken = this.broken.delete(key)
    if (wasBroken) this.log.appendLine(`${uri.fsPath}: readable again`)
    if (existing && existing.raw === raw) return wasBroken
    const parsed = parseNote(await this.folderNoteShorthand(folder, raw), baseName(uri))
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
    if (!v || typeof v !== 'object' || v.range !== undefined || v.target !== undefined || typeof v.file !== 'string') return raw
    const placed = placeFile(folder.uri.fsPath, v.file)
    if (typeof placed !== 'string') return raw
    try { if (!((await wfs.stat(vscode.Uri.joinPath(folder.uri, placed))).type & vscode.FileType.Directory)) return raw } catch { return raw }
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
      let disk: string | undefined
      try { disk = decoder.decode(await wfs.readFile(n.uri)) } catch { /* deleted: write ours */ }
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
      this.reportSaveFailure(n.uri, e as Error)
      return false
    }
    this.failed.delete(key)
    n.raw = raw
    n.base = structuredClone(n.data)
    this.notes.set(key, n)
    // Their change (a reply, a resolve) came in through our save, not the watcher: say so like the watcher would.
    if (merged) this.changed.fire()
    return true
  }

  /**
   * Not writable (an agent running as root wrote it, a read-only mount): said once per file, never silently. Several
   * at once (a folder written by another user): one message, not a stack of toasts.
   */
  private reportSaveFailure(uri: vscode.Uri, e: Error): void {
    this.log.error(`${uri.fsPath}: couldn't save: ${e.message}`)
    if (this.failed.has(uri.toString())) return
    this.failed.add(uri.toString())
    this.failNames.push(uri.path.split('/').pop()!)
    this.failWhy = e.message
    this.failTimer ??= setTimeout(() => this.showSaveFailures(), 500)
  }

  private showSaveFailures(): void {
    const names = this.failNames.splice(0)
    this.failTimer = undefined
    const why = /EACCES|EPERM|permission/i.test(this.failWhy) ? 'permission denied (written by another user?)' : this.failWhy
    const text = names.length === 1 ? `Code Notes: couldn't save ${folderName()}/${names[0]}: ${why}`
      : `Code Notes: couldn't save ${names.length} notes in ${folderName()}/: ${why}`
    this.log.error(text.replace(/^Code Notes: /, '')) // every error shown is in the Output channel too
    vscode.window.showErrorMessage(text)
  }

  /** Moves the note's file to <folder>/.trash/ (restore brings it back). */
  async trash(n: Note): Promise<void> {
    this.notes.delete(n.uri.toString())
    this.broken.delete(n.uri.toString())
    const dest = vscode.Uri.joinPath(notesDir(n.folder), '.trash', n.uri.path.split('/').pop()!)
    try { await wfs.rename(n.uri, dest, { overwrite: true }) } catch { /* already gone */ }
  }

  async restore(n: Note): Promise<void> {
    const from = vscode.Uri.joinPath(notesDir(n.folder), '.trash', n.uri.path.split('/').pop()!)
    try { await wfs.rename(from, n.uri, { overwrite: false }) } catch { await this.save({ ...n, raw: undefined }) }
    this.notes.set(n.uri.toString(), n)
  }

  async writeReadme(folder: vscode.WorkspaceFolder): Promise<void> {
    const u = vscode.Uri.joinPath(notesDir(folder), 'README.md')
    const want = agentReadme(this.person())
    let have = ''
    try { have = decoder.decode(await wfs.readFile(u)) } catch { /* none yet */ }
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
