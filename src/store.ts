import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { placeFile } from './paths'

// One JSON file per note in <workspace folder>/<codeNotes.folder>/<name>.json. One file per note so an agent and
// the extension never overwrite each other's notes. A note IS its file: the file name is its identity (an "id"
// field that disagrees is ignored). Deleted notes move to <folder>/.trash/. The format is documented in the README
// the extension writes into the folder (agentReadme below), which also names the person.

export type Role = 'human' | 'agent'
export interface Message { author: string; body: string; at?: string; role?: Role }
export const SEVERITIES = ['high', 'medium', 'low', 'nit'] as const
export type Severity = typeof SEVERITIES[number]
/** A status change: who resolved or reopened the note, and when (shown as a grey line in the thread). */
export interface NoteEvent { type: 'resolved' | 'reopened'; by: string; role?: Role; at: string }
/** Fields this version knows: everything else in a note file is kept as is when the extension rewrites it. */
const KNOWN = new Set(['id', 'file', 'range', 'anchor', 'selection', 'session', 'status', 'stale', 'claudeSession', 'createdAt', 'messages', 'severity', 'events', 'target'])

export interface NoteData {
  id: string
  /** Path relative to the workspace folder, with forward slashes. */
  file: string
  /** 1-based, inclusive. */
  range: { start: number; end: number }
  anchor: { text: string; before: string; after: string; commit?: string; branch?: string }
  /** The exact text selected when the note was made, when that was part of a line (e.g. one token). */
  selection?: { text: string; startCol: number; endCol: number }
  /** A set of notes that belong together (one review, one topic). The sidebar groups by it; it can be hidden. */
  session?: string
  status: 'open' | 'resolved'
  stale?: boolean
  /** The Claude Code session that answered this note: follow-ups resume it. */
  claudeSession?: string
  createdAt?: string
  messages: Message[]
  /** Review findings: how much it matters (sidebar icon and order). */
  severity?: Severity
  /** Status changes, oldest first. */
  events?: NoteEvent[]
  /** A note on a whole file or folder: no lines (range is 1-1 in memory and not written). */
  target?: 'file' | 'folder'
  /** Fields of the file this version doesn't know (a newer extension or an agent wrote them): written back as they were. */
  extra?: Record<string, unknown>
}

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

const msgKey = (m: Message) => `${m.author}\u0000${m.at ?? ''}\u0000${m.body}`
const evKey = (e: NoteEvent) => `${e.type}\u0000${e.by}\u0000${e.at}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Three-way merge of a note that changed on disk (an agent wrote it) while we changed it in memory. Messages are
 * append-only: theirs plus our new ones. Every other field: ours if we changed it, else theirs.
 */
export function merge(base: NoteData, ours: NoteData, theirs: NoteData): NoteData {
  const known = new Set([...base.messages, ...theirs.messages].map(msgKey))
  const pick = <K extends keyof NoteData>(k: K) => (same(ours[k], base[k]) ? theirs[k] : ours[k])
  const out: NoteData = {
    ...theirs,
    file: pick('file'), range: pick('range'), anchor: pick('anchor'), status: pick('status'), stale: pick('stale'), session: pick('session'), claudeSession: pick('claudeSession'),
    severity: pick('severity'), target: pick('target'),
    messages: [...theirs.messages, ...ours.messages.filter((m) => !known.has(msgKey(m)))],
  }
  const knownEv = new Set([...(base.events ?? []), ...(theirs.events ?? [])].map(evKey))
  const events = [...(theirs.events ?? []), ...(ours.events ?? []).filter((e) => !knownEv.has(evKey(e)))]
  if (events.length) out.events = events; else delete out.events
  for (const k of ['severity', 'target'] as const) if (out[k] === undefined) delete out[k]
  return out
}

/** Why a notes folder setting can't be used (C116), or undefined. */
export function folderProblem(v: string): string | undefined {
  const t = v.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!t || t === '.' || t === './') return 'it must be a sub-folder of its own, like .code-notes'
  if (t.startsWith('/') || /^[a-zA-Z]:/.test(t)) return 'it must be relative to the workspace folder'
  if (t.split('/').includes('..')) return 'it must stay inside the workspace folder'
  return undefined
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

/** The first message of a note file that can't be used, to name it in the list. */
export function titleOf(raw: string): string | undefined {
  try { const b = JSON.parse(raw)?.messages?.[0]?.body; return typeof b === 'string' && b.trim() ? b : undefined } catch { return undefined }
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

export function serialize(d: NoteData): string {
  const { extra, ...rest } = d
  const out: Record<string, unknown> = { ...rest }
  // A file or folder note has no lines: no range or anchor in its file.
  if (d.target) for (const k of ['range', 'anchor', 'stale', 'selection']) delete out[k]
  return JSON.stringify({ ...out, ...extra }, null, 2) + '\n'
}

/**
 * Writes a note file in one step (a hidden temp file, then a rename): an agent (or a test) reading it meanwhile sees
 * the old content or the new one, never a half-written file (the flaky "note history" test read a truncated file).
 */
export async function writeAtomic(uri: vscode.Uri, text: string): Promise<void> {
  const tmp = vscode.Uri.joinPath(uri, '..', `.${uri.path.split('/').pop()}.${process.pid}.tmp`)
  await vscode.workspace.fs.writeFile(tmp, encoder.encode(text))
  // Node's rename replaces the file in one step; VS Code's rename with overwrite deletes it first (a moment with no file).
  try { if (uri.scheme === 'file') await fs.promises.rename(tmp.fsPath, uri.fsPath); else await vscode.workspace.fs.rename(tmp, uri, { overwrite: true }) }
  catch (e) { try { await vscode.workspace.fs.delete(tmp) } catch { /* gone */ } throw e }
}

const baseName = (uri: vscode.Uri) => uri.path.split('/').pop()!.replace(/\.json$/, '')

/** Checks a note file's content; returns the note or why it is not one. `id` is the file's name. */
export function parseNote(raw: string, id: string): NoteData | string {
  let v: any
  try { v = JSON.parse(raw) } catch (e) { return `not valid JSON (${(e as Error).message})` }
  if (!v || typeof v !== 'object') return 'not a JSON object'
  if (typeof v.file !== 'string' || !v.file) return 'missing "file"'
  if (v.target !== undefined && v.target !== 'file' && v.target !== 'folder') return `"target" is "${v.target}": use "file" or "folder" (or leave it out for lines)`
  const target: 'file' | 'folder' | undefined = v.target
  if (target) v.range = { start: 1, end: 1 }
  if (!v.range || !Number.isInteger(v.range.start) || !Number.isInteger(v.range.end)) return '"range" needs integer start and end (or "target": "file" for a whole file)'
  if (v.range.start < 1) return `"range.start" is ${v.range.start}: lines are 1-based`
  if (v.range.end < v.range.start) return `"range" ends (${v.range.end}) before it starts (${v.range.start})`
  if (v.status !== undefined && v.status !== 'open' && v.status !== 'resolved') return `"status" is "${v.status}": use "open" or "resolved"`
  if (!Array.isArray(v.messages)) return '"messages" must be an array'
  if (!v.messages.length) return '"messages" is empty: a note needs at least one message'
  for (const [i, m] of v.messages.entries()) if (!m || typeof m.body !== 'string') return `message ${i + 1} needs a "body" string`
  const start = Math.max(1, v.range.start)
  // An unknown severity ("critical") is not an error: it is kept in the file but shown as none.
  const severity = SEVERITIES.includes(v.severity) ? v.severity as Severity : undefined
  const extra = Object.fromEntries(Object.entries(v).filter(([k]) => !KNOWN.has(k) || (k === 'severity' && !severity)))
  const events: NoteEvent[] = (Array.isArray(v.events) ? v.events : [])
    .filter((e: any) => e && (e.type === 'resolved' || e.type === 'reopened') && typeof e.at === 'string')
    .map((e: any) => ({ type: e.type, by: String(e.by ?? 'unknown'), ...(e.role === 'human' || e.role === 'agent' ? { role: e.role } : {}), at: e.at }))
  return {
    id,
    file: v.file.replace(/\\/g, '/').replace(/^\.\//, ''),
    range: { start, end: Math.max(start, v.range.end) },
    anchor: {
      text: String(v.anchor?.text ?? ''), before: String(v.anchor?.before ?? ''), after: String(v.anchor?.after ?? ''),
      ...(typeof v.anchor?.commit === 'string' ? { commit: v.anchor.commit } : {}),
      ...(typeof v.anchor?.branch === 'string' ? { branch: v.anchor.branch } : {}),
    },
    ...(typeof v.session === 'string' && v.session.trim() ? { session: v.session.trim() } : {}),
    ...(typeof v.claudeSession === 'string' && v.claudeSession ? { claudeSession: v.claudeSession } : {}),
    // A plain string (the obvious shorthand) is the text; columns are only informational.
    ...(typeof v.selection === 'string' && v.selection.trim() ? { selection: { text: v.selection, startCol: 0, endCol: 0 } }
      : v.selection && typeof v.selection.text === 'string' ? { selection: { text: v.selection.text, startCol: Number(v.selection.startCol) || 0, endCol: Number(v.selection.endCol) || 0 } } : {}),
    status: v.status === 'resolved' ? 'resolved' : 'open',
    stale: !target && !!v.stale,
    ...(typeof v.createdAt === 'string' ? { createdAt: v.createdAt } : {}),
    // A missing "at" stays missing: unread state does not depend on it, and inventing one would be a lie.
    messages: v.messages.map((m: any) => ({
      author: String(m.author ?? 'unknown'),
      ...(m.role === 'human' || m.role === 'agent' ? { role: m.role } : {}),
      body: m.body,
      ...(typeof m.at === 'string' ? { at: m.at } : {}),
    })),
    ...(severity ? { severity } : {}),
    ...(events.length ? { events } : {}),
    ...(target ? { target } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
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
  /** Files a save failed for (reported once until a save works again). */
  private readonly failed = new Set<string>()
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
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${folderName()}/*.json`))
      w.onDidCreate((u) => this.readFile(folder, u).then((c) => c && this.changed.fire()))
      w.onDidChange((u) => this.readFile(folder, u).then((c) => c && this.changed.fire()))
      w.onDidDelete(async (u) => {
        // A file replaced by a rename (our atomic save, an agent's tmp + mv) may be reported as deleted: it is there.
        try { await vscode.workspace.fs.stat(u); return } catch { /* really gone */ }
        const n = this.notes.get(u.toString())
        if (!this.forget(u)) return
        // Not our own delete (trash forgets the note first): keep its last version in.trash so it can be restored.
        if (n?.raw && u.path.startsWith(notesDir(n.folder).path + '/')) {
          try { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(notesDir(n.folder), '.trash', u.path.split('/').pop()!), encoder.encode(n.raw)) } catch { /* best effort */ }
          this.log.appendLine(`${u.fsPath}: deleted on disk; the last version is in ${folderName()}/.trash`)
          this.deletedOnDisk.fire(n)
        }
        this.changed.fire()
      })
      this.watchers.push(w)
      let entries: [string, vscode.FileType][] = []
      try { entries = await vscode.workspace.fs.readDirectory(notesDir(folder)) } catch { continue }
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith('.json')) await this.readFile(folder, vscode.Uri.joinPath(notesDir(folder), name))
      }
      if (entries.length) await this.writeReadme(folder)
      this.log.appendLine(`${folder.name}: ${[...this.notes.values()].filter((n) => n.folder === folder).length} notes in ${folderName()}/${this.broken.size ? `, ${this.broken.size} unreadable` : ''}`)
    }
    this.changed.fire()
  }

  /** Reads one note file; true if anything changed. */
  private async readFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<boolean> {
    // Dot files are not notes (`.request.json`: a script's request for the extension).
    if (baseName(uri).startsWith('.')) return false
    let raw: string
    try { raw = decoder.decode(await vscode.workspace.fs.readFile(uri)) } catch { return this.forget(uri) }
    const key = uri.toString()
    const existing = this.notes.get(key)
    // A file that parses again (an agent finished its write, or it was restored) is no longer broken.
    const wasBroken = this.broken.delete(key)
    if (wasBroken) this.log.appendLine(`${uri.fsPath}: readable again`)
    if (existing && existing.raw === raw) return wasBroken
    let parsed = parseNote(await this.folderNoteShorthand(folder, raw), baseName(uri))
    if (typeof parsed !== 'string') {
      const placed = placeFile(folder.uri.fsPath, parsed.file)
      if (typeof placed !== 'string') parsed = placed.error
      else {
        if (placed !== parsed.file) this.log.appendLine(`note ${parsed.id}: path "${parsed.file}" read as "${placed}"`)
        parsed.file = placed
        const why = await this.targetProblem(folder, placed, parsed)
        if (why) parsed = why
      }
    }
    if (typeof parsed === 'string') {
      // Half-written, most likely: keep the last good version and say why.
      this.broken.set(key, parsed)
      const title = titleOf(raw)
      if (title) this.brokenTitle.set(key, title); else this.brokenTitle.delete(key)
      this.log.warn(`${uri.fsPath}: ${parsed}`)
      return true
    }
    this.brokenTitle.delete(key)
    this.notes.set(key, { data: parsed, folder, uri, raw, base: structuredClone(parsed) })
    return true
  }

  /** `{ "file": "src/api", … }` with no range: a folder note, when that is a folder (agents leave "target" out). */
  private async folderNoteShorthand(folder: vscode.WorkspaceFolder, raw: string): Promise<string> {
    let v: any
    try { v = JSON.parse(raw) } catch { return raw }
    if (!v || typeof v !== 'object' || v.range !== undefined || v.target !== undefined || typeof v.file !== 'string') return raw
    const placed = placeFile(folder.uri.fsPath, v.file)
    if (typeof placed !== 'string') return raw
    try { if (!((await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, placed))).type & vscode.FileType.Directory)) return raw } catch { return raw }
    return JSON.stringify({ ...v, target: 'folder' })
  }

  /**
   * Why a note can't point at this path (through a symlink, something outside the workspace), or undefined. A note
   * whose "file" is a folder is a folder note; a "folder" note on a file is a file note.
   */
  private async targetProblem(folder: vscode.WorkspaceFolder, file: string, d: NoteData): Promise<string | undefined> {
    const uri = vscode.Uri.joinPath(folder.uri, file)
    try {
      const dir = !!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory)
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
      try { disk = decoder.decode(await vscode.workspace.fs.readFile(n.uri)) } catch { /* deleted: write ours */ }
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
      // Not writable (an agent running as root wrote it, a read-only mount): say so once, never silently.
      this.log.error(`${n.uri.fsPath}: couldn't save: ${(e as Error).message}`)
      if (!this.failed.has(key)) {
        this.failed.add(key)
        // Several at once (a folder written by another user): one message, not a stack of toasts.
        this.failNames.push(n.uri.path.split('/').pop()!)
        this.failWhy = (e as Error).message
        if (!this.failTimer) this.failTimer = setTimeout(() => {
          const names = this.failNames.splice(0)
          this.failTimer = undefined
          const why = /EACCES|EPERM|permission/i.test(this.failWhy) ? 'permission denied (written by another user?)' : this.failWhy
          const text = names.length === 1 ? `Code Notes: couldn't save ${folderName()}/${names[0]}: ${why}`
            : `Code Notes: couldn't save ${names.length} notes in ${folderName()}/: ${why}`
          this.log.error(text.replace(/^Code Notes: /, '')) // every error shown is in the Output channel too
          vscode.window.showErrorMessage(text)
        }, 500)
      }
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

  /** Moves the note's file to <folder>/.trash/ (restore brings it back). */
  async trash(n: Note): Promise<void> {
    this.notes.delete(n.uri.toString())
    this.broken.delete(n.uri.toString())
    const dest = vscode.Uri.joinPath(notesDir(n.folder), '.trash', n.uri.path.split('/').pop()!)
    try { await vscode.workspace.fs.rename(n.uri, dest, { overwrite: true }) } catch { /* already gone */ }
  }

  async restore(n: Note): Promise<void> {
    const from = vscode.Uri.joinPath(notesDir(n.folder), '.trash', n.uri.path.split('/').pop()!)
    try { await vscode.workspace.fs.rename(from, n.uri, { overwrite: false }) } catch { await this.save({ ...n, raw: undefined }) }
    this.notes.set(n.uri.toString(), n)
  }

  async writeReadme(folder: vscode.WorkspaceFolder): Promise<void> {
    const u = vscode.Uri.joinPath(notesDir(folder), 'README.md')
    const want = agentReadme(this.person())
    let have = ''
    try { have = decoder.decode(await vscode.workspace.fs.readFile(u)) } catch { /* none yet */ }
    if (have !== want) await vscode.workspace.fs.writeFile(u, encoder.encode(want))
  }

  private async ensureFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const dir = notesDir(folder)
    // Only a folder Code Notes made (or already uses) gets a.gitignore: never someone else's folder (C116).
    let ours = true
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir)
      ours = entries.some(([n]) => n === 'README.md') || entries.every(([n]) => n.endsWith('.json'))
    } catch { /* new folder */ }
    try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, 'README.md')) } catch { await this.writeReadme(folder) }
    const gi = vscode.Uri.joinPath(dir, '.gitignore')
    if (ours) try { await vscode.workspace.fs.stat(gi) } catch { await this.writeGitignore(folder) }
  }

  /** Out of git: everything. Shared through git: still not the trash (deleted notes). */
  async writeGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
    const on = vscode.workspace.getConfiguration('codeNotes').get<boolean>('ignoreInGit', true)
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(notesDir(folder), '.gitignore'), encoder.encode(on ? '*\n' : '.trash/\n'))
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    this.changed.dispose()
    this.deletedOnDisk.dispose()
  }
}
