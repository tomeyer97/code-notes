import * as vscode from 'vscode'
import { Beats } from './beats'
import { TutorialSpot } from './tutorialSpot'
import { devReload } from './devReload'
import { CodeLinks } from './codeLinks'
import { readValues, ValueHints } from './valueHints'
import { linkPhrases, readLinks } from './codeLinkText'
import { execFile } from 'child_process'
import { anchor, shift, swallows, lineDiff, Loc } from './anchor'
import { Ask, AskResult, findCli } from './claude'
import { folderName, folderProblem, journeysFolderName, Message, Note, NoteData, NoteEvent, serialize, Severity, Store } from './store'
import { fileOf, Journeys, LoadedJourney, MAP_VIEW, MapMessage, MapPanel, posKey, StepAt } from './journeys'
import { escapeTags, linkPaths } from './journeyModel'
import { linkify } from './answerLinks'
import { scoreJourney } from './match'
import { clock, journeyPrompt, journeyRules, minutes, modelProblem, phaseOf } from './writing'

const CONTROLLER_ID = 'codeNotes'
const SEEN_KEY = 'codeNotes.seenCount' // note id -> how many of its messages the person has seen
const SEEN_EV_KEY = 'codeNotes.seenEvents' // note id -> how many of its status changes the person has seen
const GROUP_KEY = 'codeNotes.groupBy'
/**
 * The chord prefix, as the UI names it: Ctrl+' then a plain letter. Both prefixes (Ctrl+' and, on ISO keyboards,
 * Ctrl+<) run the same commands; hints show the one last used, Ctrl+' until then (it exists on every layout).
 */
let KEY = "Ctrl+'"
const PREFIX_KEY = 'codeNotes.chordPrefix'
let gstate: vscode.Memento
const TUTORIAL_KEY = 'codeNotes.tutorialSeen'
/** What the map's tutorial shows (for the integration test). */
const tutorialSeen = { bar: 0, card: 0, done: 0, skip: 0, inside: 0 }
const OLD_SEEN_KEY = 'codeNotes.seen' // v0.1: note id -> ISO time (migrated)
const CONTEXT_LINES = 2

type Filter = 'all' | 'unread' | 'needsMe' | 'waiting' | 'stale'
const FILTERS: { id: Filter; label: string; detail: string }[] = [
  { id: 'all', label: 'All notes', detail: 'Open notes (and resolved ones when shown)' },
  { id: 'unread', label: 'Unread', detail: 'Notes with replies you have not seen' },
  { id: 'stale', label: 'Stale', detail: 'The code under the note changed' },
]

let store: Store
let controller: vscode.CommentController
let tree: NotesTree
let treeView: vscode.TreeView<Node>
let statusItem: vscode.StatusBarItem
let moveItem: vscode.StatusBarItem
let state: vscode.Memento
let log: vscode.LogOutputChannel
let showResolved = false
let filter: Filter = 'all'
let gitName: string | undefined
/** The note the person just opened: its thread shows even when resolved. */
let revealedId: string | undefined
/** For the note being visited: messages from this index on keep their "new" label until the next note is opened. */
const visitFrom = new Map<string, number>()
/** Message count and status per note as last seen from disk, to notice replies on resolved notes. */
const shape = new Map<string, { count: number; status: string; events: number }>()
const shapeOf = (n: Note) => ({ count: n.data.messages.length, status: n.data.status, events: n.data.events?.length ?? 0 })
/** Notes whose code file does not exist (deleted or moved). */
const missing = new Set<string>()
/** Notes whose range starts past the end of their file: note id -> the file's line count. */
const pastEnd = new Map<string, number>()
let pendingMove: string | undefined
const threads = new Map<string, vscode.CommentThread>() // note id -> thread
const checked = new Set<string>() // note ids selected in the sidebar (2 or more: bulk actions)
let journeys: Journeys
let mapPanel: MapPanel
let beats: Beats
let tutorialSpot: TutorialSpot
let codeLinks: CodeLinks
let valueHints: ValueHints
/** The journey whose map is open (its file URI), and the step shown (1-based; 0: browsing the map, no tour running). */
let tourKey: string | undefined
let tourStep = 0
/** The current step's id: the tour follows the step, not its number, when the journey is edited. */
let tourId: string | undefined
let tourItems: { prev: vscode.StatusBarItem; pos: vscode.StatusBarItem; next: vscode.StatusBarItem; end: vscode.StatusBarItem }
/** The step card: read-only comment threads of their own controller (no menus, no reply box). */
let stepController: vscode.CommentController
let stepThread: vscode.CommentThread | undefined
let stepDetailsOpen = false
/** Empty note boxes opened by "Ask about this step": what the note will say it is about. */
const stepAsks = new Map<vscode.CommentThread, { about: string; link: { id: string; step: string; n: number } }>()
/** The file the tour last opened, in the code group (its preview tab is closed when the tour ends). */
let tourDoc: { uri: vscode.Uri; column: vscode.ViewColumn } | undefined
let stepDeco: { at: vscode.TextEditorDecorationType; stale: vscode.TextEditorDecorationType }
/** A reference opened from the step card: its lines are highlighted, with "← Back to step n" above them (R8). */
let refHere: { uri: string; start: number; end: number } | undefined
/** The last ref opened as a peek under the step (for the tests). */
let lastPeek: { uri: string; start: number; end: number; under?: number } | undefined
let refDeco: vscode.TextEditorDecorationType | undefined
/** Until then, cursor moves are the journey's, not the reader's. */
let tourCursorUntil = 0
/** The marker line above the step ("panel") and "Back to step" above a ref: code lenses. */
const lensChanged = new vscode.EventEmitter<void>()
const TOUR_KEY = 'codeNotes.tour' // posKey of the running tour (restored after a reload)
const POS_KEY = 'codeNotes.journeyPos' // posKey -> where each journey was left { step, at }
const MAP_KEY = 'codeNotes.mapJourney' // posKey of the journey last shown on the map
let extUri: vscode.Uri
let groupMode: 'file' | 'session' = 'file'
let deco: Record<'open' | 'openBar' | 'stale' | 'staleBar' | 'unread' | 'exact', vscode.TextEditorDecorationType>

const cfg = () => vscode.workspace.getConfiguration('codeNotes')
/** The OS account name: not shown (in a container it is "openvscode-server"), but notes written under it are yours. */
const osName = (() => { try { return require('os').userInfo().username as string } catch { return undefined } })()
const me = () => cfg().get<string>('author') || gitName || 'You'
/** Names this person wrote under before (the author setting changed): still theirs. */
const PAST_KEY = 'codeNotes.pastNames'
const pastNames = () => state.get<string[]>(PAST_KEY) ?? []
let lastMe = ''
/** Yours: written under your name, an earlier name of yours, or "me" (the old default). */
const mine = (m: Message) => m.author === me() || m.author === 'me' || m.author === 'You' || (!!osName && m.author === osName) || pastNames().includes(m.author)
const evMine = (e: NoteEvent) => e.by === me() || e.by === 'me' || e.by === 'You' || (!!osName && e.by === osName) || pastNames().includes(e.by)
/** An agent's message: marked as such, or (unmarked) not yours. */
const isAgent = (m: Message) => m.role === 'agent' || (!m.role && !mine(m))
const now = () => new Date().toISOString()
const setCtx = (k: string, v: unknown) => vscode.commands.executeCommand('setContext', k, v)
const notes = () => store.all()
const byId = (id: string) => store.get(id)

// ---------- identity ----------

function git(folder: vscode.WorkspaceFolder | undefined, args: string[]): Promise<string | undefined> {
  if (!folder || folder.uri.scheme !== 'file') return Promise.resolve(undefined)
  return new Promise((resolve) => execFile('git', args, { cwd: folder.uri.fsPath, timeout: 3000 }, (err, out) =>
    resolve(err ? undefined : out.trim() || undefined)))
}
const detectGitName = (folder: vscode.WorkspaceFolder | undefined) => git(folder, ['config', 'user.name'])
/** The checked-out branch per workspace folder (updated when.git/HEAD changes). */
const branches = new Map<string, string | undefined>()
async function refreshBranch(folder: vscode.WorkspaceFolder): Promise<void> {
  branches.set(folder.uri.toString(), await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']))
}
/** The note was written on another branch than the one checked out now. */
function otherBranch(n: Note): string | undefined {
  const now = branches.get(n.folder.uri.toString())
  return n.data.anchor.branch && now && now !== n.data.anchor.branch ? n.data.anchor.branch : undefined
}

// ---------- read state (per person, kept out of the shared note files) ----------

function seenMap(): Record<string, number> { return state.get<Record<string, number>>(SEEN_KEY) ?? {} }
function seenCount(n: Note): number { return seenMap()[n.data.id] ?? 0 }
function seenEvMap(): Record<string, number> { return state.get<Record<string, number>>(SEEN_EV_KEY) ?? {} }
function seenEvents(n: Note): number { return seenEvMap()[n.data.id] ?? 0 }

/** Resolves the person hasn't seen, by someone else: a resolved note would otherwise vanish silently. (A reopen
 * by someone else needs no flag: the note is open and listed, and it usually comes with their reply.) */
function unreadEvents(n: Note): number { return (n.data.events ?? []).slice(seenEvents(n)).filter((e) => e.type === 'resolved' && !evMine(e)).length }
/** Messages after the ones the person has seen, not written by them, and others' status changes. Independent of anyone's clock. */
function unread(n: Note): number { return n.data.messages.slice(seenCount(n)).filter((m) => !mine(m)).length + unreadEvents(n) }

async function setSeen(entries: [string, number][]): Promise<void> {
  if (!entries.length) return
  await state.update(SEEN_KEY, { ...seenMap(), ...Object.fromEntries(entries) })
}
async function setSeenEvents(entries: [string, number][]): Promise<void> {
  if (!entries.length) return
  await state.update(SEEN_EV_KEY, { ...seenEvMap(), ...Object.fromEntries(entries) })
}

/** Marks notes read; `visit` keeps this note's "new" labels for the visit. */
async function markRead(list: Note[], visit?: Note): Promise<void> {
  const changes: [string, number][] = []
  const evChanges: [string, number][] = []
  for (const n of list) {
    const evs = n.data.events?.length ?? 0
    if (seenEvents(n) < evs) evChanges.push([n.data.id, evs])
    const was = seenCount(n)
    if (was >= n.data.messages.length) continue
    if (visit && n === visit && unread(n)) visitFrom.set(n.data.id, was)
    changes.push([n.data.id, n.data.messages.length])
  }
  await setSeen(changes)
  await setSeenEvents(evChanges)
  refreshAll()
}

/** Records a status change in the note's history. */
function addEvent(n: Note, type: NoteEvent['type'], by = me(), role: NoteEvent['role'] = 'human'): void {
  n.data.events = [...(n.data.events ?? []), { type, by, ...(role ? { role } : {}), at: now() }]
}

async function migrateSeen(): Promise<void> {
  const old = state.get<Record<string, string>>(OLD_SEEN_KEY)
  if (!old) return
  const changes: [string, number][] = []
  for (const n of notes()) {
    const at = Date.parse(old[n.data.id] ?? '')
    if (!at || seenMap()[n.data.id] !== undefined) continue
    let count = 0
    for (const m of n.data.messages) { if ((Date.parse(m.at ?? '') || 0) <= at) count++; else break }
    changes.push([n.data.id, count])
  }
  await setSeen(changes)
  await state.update(OLD_SEEN_KEY, undefined)
}

// ---------- files and anchoring ----------

/** The file or folder the note is about, on disk. */
function pathUri(n: Note): vscode.Uri { return vscode.Uri.joinPath(n.folder.uri, n.data.file) }
/** A folder note's thread lives on a read-only page about the folder (there is no document to put it on). */
const FOLDER_SCHEME = 'code-notes-folder'
function folderPage(folder: vscode.WorkspaceFolder, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: FOLDER_SCHEME, path: `/${file} (folder)`, query: folder.uri.toString() })
}
/** The document the note's thread is on. */
function docUri(n: Note): vscode.Uri { return n.data.target === 'folder' ? folderPage(n.folder, n.data.file) : pathUri(n) }
/** Notes on lines (not a whole file or folder) of this document: the ones that follow edits. */
const lineNotesFor = (uri: vscode.Uri) => notesFor(uri).filter((n) => !n.data.target)

function relPath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const base = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/'
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : vscode.workspace.asRelativePath(uri, false)
}

function notesFor(uri: vscode.Uri): Note[] {
  return notes().filter((n) => docUri(n).toString() === uri.toString())
}

function openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
}

function linesOf(doc: vscode.TextDocument): string[] {
  const out: string[] = []
  for (let i = 0; i < doc.lineCount; i++) out.push(doc.lineAt(i).text)
  return out
}

async function linesOfUri(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = openDoc(uri)
  // An editor with unsaved changes is the truth; otherwise the disk is (VS Code keeps closed or deleted files' documents around).
  if (open && !open.isClosed && open.isDirty) return linesOf(open)
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/) } catch { return undefined }
}

const toLoc = (d: NoteData): Loc => ({ start: d.range.start - 1, end: d.range.end - 1 })

/** The anchor a note had before its suggestion was applied (and after, once undone): Ctrl+Z / redo swap them. */
const otherAnchor = new Map<string, NoteData['anchor']>()

/** Re-anchors a note against the file's current lines; true if its position or stale flag changed. */
function reanchor(n: Note, lines: string[] | undefined, tracked = toLoc(n.data), hint = tracked.start): boolean {
  let loc: Loc, stale: boolean
  if (!lines) { missing.add(n.data.id); loc = tracked; stale = true }
  else {
    missing.delete(n.data.id)
    ;({ loc, stale } = anchor(lines, n.data.anchor.text, n.data.anchor.before, n.data.anchor.after, tracked, hint))
    // An applied suggestion was undone (or redone): the code the note had before is back, so is its anchor.
    const alt = otherAnchor.get(n.data.id)
    if (stale && alt) {
      const r = anchor(lines, alt.text, alt.before, alt.after, tracked, hint)
      if (!r.stale) { otherAnchor.set(n.data.id, n.data.anchor); n.data.anchor = alt; loc = r.loc; stale = false }
    }
  }
  const range = { start: loc.start + 1, end: loc.end + 1 }
  if (range.start === n.data.range.start && range.end === n.data.range.end && !!n.data.stale === stale) return false
  if (stale !== !!n.data.stale) log.info(`note ${n.data.id}: ${stale ? (lines ? 'stale (the code changed)' : 'stale (file not found)') : 'no longer stale'} · ${n.data.file}`)
  else if (range.start !== n.data.range.start) log.info(`note ${n.data.id}: followed its code ${n.data.file} L${n.data.range.start} → L${range.start}`)
  n.data.range = range
  n.data.stale = stale
  return true
}

/** Saves a note unless its code has unsaved changes: positions in a dirty editor are not the file on disk. */
async function saveIfClean(n: Note): Promise<void> {
  const d = openDoc(docUri(n))
  if (d?.isDirty) return
  // On another branch, positions and stale are about this checkout only: don't rewrite the shared file for them.
  if (otherBranch(n) && n.base && JSON.stringify(n.base.messages) === JSON.stringify(n.data.messages) && n.base.status === n.data.status) return
  await store.save(n)
}

/** A file or folder note: only whether its file/folder is still there. True if that changed. */
async function checkTarget(n: Note): Promise<boolean> {
  let there = false
  try { const st = await vscode.workspace.fs.stat(pathUri(n)); there = n.data.target === 'folder' ? !!(st.type & vscode.FileType.Directory) : !(st.type & vscode.FileType.Directory) } catch { /* gone */ }
  const was = missing.has(n.data.id)
  if (there) missing.delete(n.data.id); else missing.add(n.data.id)
  n.data.stale = !there
  if (was !== !there) log.info(`note ${n.data.id}: ${there ? 'found' : 'not found'} · ${n.data.file}`)
  return was !== !there
}

async function reanchorAll(): Promise<void> {
  const byFile = new Map<string, Note[]>()
  for (const n of notes()) {
    if (n.data.target) { await checkTarget(n); continue }
    const k = docUri(n).toString()
    byFile.set(k, [...(byFile.get(k) ?? []), n])
  }
  for (const [uri, list] of byFile) {
    let lines = await linesOfUri(vscode.Uri.parse(uri))
    // An agent wrote the path with the workspace folder's name in front ("runner/src/x.ts"): fix it if that file exists.
    if (!lines) {
      for (const n of list) {
        const prefix = `${n.folder.name}/`
        if (!n.data.file.startsWith(prefix)) continue
        const fixed = n.data.file.slice(prefix.length)
        const l = await linesOfUri(vscode.Uri.joinPath(n.folder.uri, fixed))
        if (!l) continue
        log.appendLine(`note ${n.data.id}: path "${n.data.file}" fixed to "${fixed}"`)
        n.data.file = fixed
        missing.delete(n.data.id)
        lines = l
      }
    }
    for (const n of list) {
      // A note an agent created without an anchor: take it from the code at its range, once.
      const a = n.data.anchor
      if (lines && n.data.range.start > lines.length) {
        pastEnd.set(n.data.id, lines.length)
        if (!n.data.stale) { n.data.stale = true; log.warn(`note ${n.data.id}: line ${n.data.range.start} is past the end of ${n.data.file} (${lines.length} lines)`); await saveIfClean(n) }
        continue
      }
      pastEnd.delete(n.data.id)
      if (lines && !a.text && !a.before && !a.after) {
        const loc = toLoc(n.data)
        const end = Math.min(loc.end, lines.length - 1)
        n.data.anchor = { ...captureAnchor(lines, Math.min(loc.start, end), end), ...(await commitInfo(n.folder)) }
        await saveIfClean(n)
        continue
      }
      if (reanchor(n, lines)) await saveIfClean(n)
    }
  }
}

async function linesOfDisk(uri: vscode.Uri): Promise<string[] | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/) } catch { return undefined }
}

async function commitInfo(folder: vscode.WorkspaceFolder): Promise<{ commit?: string; branch?: string }> {
  const [commit, branch] = await Promise.all([git(folder, ['rev-parse', '--short', 'HEAD']), git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) }
}

function captureAnchor(lines: string[], start: number, end: number): NoteData['anchor'] {
  return {
    text: lines.slice(start, end + 1).join('\n'),
    before: lines.slice(Math.max(0, start - CONTEXT_LINES), start).join('\n'),
    after: lines.slice(end + 1, end + 1 + CONTEXT_LINES).join('\n'),
  }
}

/** The lines of a selection: one ending at column 0 or inside the indentation of a line does not include that line. */
function rangeLines(doc: vscode.TextDocument, s: vscode.Range): Loc {
  let end = s.end.line
  if (end > s.start.line && !doc.lineAt(end).text.slice(0, s.end.character).trim()) end--
  return { start: s.start.line, end }
}
const selectedLines = (editor: vscode.TextEditor): Loc => rangeLines(editor.document, editor.selection)
/** Code Notes' own folder (notes, README): no notes on those. */
const inNotesFolder = (uri: vscode.Uri) => uri.path.includes(`/${folderName()}/`)

/** Notes whose file disappeared: look for their code in files created just now (git mv, mv, refactors). */
const recentCreates: { uri: vscode.Uri; at: number }[] = []
async function followMovedFiles(): Promise<void> {
  const cutoff = Date.now() - 15_000
  while (recentCreates.length && recentCreates[0].at < cutoff) recentCreates.shift()
  for (const n of notes()) {
    if (n.data.target) { await checkTarget(n); continue }
    try { await vscode.workspace.fs.stat(docUri(n)); continue } catch { /* gone */ }
    let moved = false
    // Nothing to recognise the code by (an agent's note on a path that never existed): any file would "match".
    const a = n.data.anchor
    const knowable = !!a.text.trim() || !!a.before.trim() || !!a.after.trim()
    for (const c of knowable ? recentCreates : []) {
      const folder = vscode.workspace.getWorkspaceFolder(c.uri)
      const lines = await linesOfUri(c.uri)
      if (!folder || folder !== n.folder || !lines) continue
      const r = anchor(lines, n.data.anchor.text, n.data.anchor.before, n.data.anchor.after, toLoc(n.data))
      if (r.stale) continue
      log.appendLine(`note ${n.data.id}: ${n.data.file} moved to ${relPath(folder, c.uri)}`)
      n.data.file = relPath(folder, c.uri)
      n.data.range = { start: r.loc.start + 1, end: r.loc.end + 1 }
      n.data.stale = false
      missing.delete(n.data.id)
      await store.save(n)
      moved = true
      break
    }
    if (!moved && reanchor(n, undefined)) await store.save(n)
  }
  refreshAll()
}

// ---------- comment threads ----------

function threadRange(n: Note): vscode.Range {
  return new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
}

function lines(n: Note): string {
  if (n.data.target) return n.data.target === 'folder' ? 'folder' : 'whole file'
  return n.data.range.start === n.data.range.end ? `L${n.data.range.start}` : `L${n.data.range.start}–${n.data.range.end}`
}

const FENCE = /(```[\s\S]*?```)/g
const SUGGESTION = /^```suggestion[ \t]*\r?\n([\s\S]*?)\r?\n?```$/
/** The k-th ```suggestion block of a message. */
function suggestionOf(body: string, k: number): string | undefined {
  return body.split(FENCE).map((seg) => SUGGESTION.exec(seg)?.[1]).filter((x): x is string => x !== undefined)[k]
}

/**
 * Markdown of a message: relative links and `path:line` references open the file (C84); images become links (C87).
 * `mi`: the message's index, for an agent's message: its ```suggestion blocks get an Apply link.
 */
function messageMarkdown(n: Note, body: string, mi?: number, index = mi): vscode.MarkdownString {
  const link = (text: string, file: string, line?: string) =>
    `[${text.replace(/[[\]]/g, '\\$&')}](command:codeNotes.openAt?${encodeURIComponent(JSON.stringify([n.folder.uri.toString(), file, Number(line) || 1]))})`
  const home = require('os').homedir() as string
  const parts = body.split(FENCE)
  let k = 0
  const out = parts.map((seg) => {
    if (seg.startsWith('```')) {
      const sug = mi !== undefined && !n.data.target ? SUGGESTION.exec(seg) : null
      if (!sug) return seg
      return `\`\`\`\n${sug[1]}\n\`\`\`\n\n[Apply suggestion](command:codeNotes.applySuggestion?${encodeURIComponent(JSON.stringify([n.data.id, mi, k++]))} "Replace ${lines(n)} with this · Ctrl+Z undoes")`
    }
    // also inside "(…)" and lists; repo-relative labels, never the home folder's path.
    return linkify(seg, n.folder.uri.fsPath, home, link)
  }).join('')
  // Asked from a journey step: the line saying so links back to that step on the map.
  const sl = index === 0 ? stepLinkOf(n) : undefined
  // The step's number now (found by id), else the one it had.
  const nowN = () => { const lj = journeyOfNote(n); const i = lj && sl?.step ? lj.j.steps.findIndex((x) => x.id === sl.step) : -1; return i >= 0 ? i + 1 : sl!.n }
  const walking = () => { const lj = journeyOfNote(n); return !!lj && touring() && tourKey === lj.key }
  // On that very step, no back-link at all: the card is right there.
  const onIt = () => walking() && (sl!.step ? tourId === sl!.step : tourStep === sl!.n)
  const back = (t: string) => `[↩ Step ${nowN()}${walking() ? '' : ` · ${t}`}](command:codeNotes.openStepLink?${encodeURIComponent(JSON.stringify([sl!.id, sl!.step ?? '', sl!.n]))} "Open this step on the journey's map")`
  const linked = sl && onIt() ? out.replace(/\n*_About (step \d+ of the journey “[^”]*”: [^\n]*|the step “[^”]*” \(id [^)]*\) of the journey “[^”]*”)_\s*$/, '')
    : sl ? out.replace(/_About step (\d+) of the journey “([^”]*)”: ([^\n]*)_\s*$/, (_m, _k: string, t: string) => back(t))
    .replace(/_About the step “[^”]*” \(id [^)]*\) of the journey “([^”]*)”_\s*$/, (_m, t: string) => back(t)) : out
  const md = new vscode.MarkdownString(linked)
  md.isTrusted = { enabledCommands: ['codeNotes.openAt', 'codeNotes.expandThread', 'codeNotes.applySuggestion', 'codeNotes.openStepLink'] }
  md.baseUri = n.folder.uri
  return md
}

/** Notes whose whole thread the person asked to see; others hide older read replies (C86 C107). */
const expanded = new Set<string>()
const COLLAPSE_OVER = 6

// ---------- Claude answers notes (headless Claude Code, see claude.ts) ----------

const asking = new Map<string, { ask?: Ask; text: string; activity?: string; started: number; cancelled?: boolean }>()
const askErrors = new Map<string, string>()
const askQueue: string[] = []
const MAX_ASKS = 3
const claudeMode = () => cfg().get<string>('claude.mode', 'button')

/**
 * Claude runs (answering a note, a step's question, writing a journey) run tools in the repository, the skill's
 * own scripts among them: only in a trusted folder. In Restricted Mode one line says why, with a button that opens
 * the trust editor; reading journeys and notes stays available.
 */
let trustedForTest: boolean | undefined
const trusted = () => trustedForTest ?? vscode.workspace.isTrusted
function claudeAllowed(what: string): boolean {
  if (trusted()) return true
  log.info(`${what}: not run: this folder is in Restricted Mode (not trusted)`)
  void vscode.window.showInformationMessage(`Trust this folder to let Claude ${what}.`, 'Manage Trust').then((b) => {
    if (b) void vscode.commands.executeCommand('workbench.trust.manage')
  })
  return false
}

/** an error the person is shown also goes to the Output channel as [error]. */
function showError(text: string, ...items: string[]): Thenable<string | undefined> {
  if (log) log.error(text.replace(/^Code Notes: /, ''))
  return vscode.window.showWarningMessage(text, ...items)
}

/** Markdown the extension writes itself, allowed to run its own commands. */
function systemMarkdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text)
  md.isTrusted = { enabledCommands: ['codeNotes.askClaude', 'codeNotes.cancelClaude', 'codeNotes.expandThread', 'codeNotes.openAt'] }
  return md
}
const cmdLink = (label: string, command: string, ...args: unknown[]) => `[${label}](command:${command}${args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : ''})`

/** Claude Code skills a note may use: the Skill tool, Bash for each skill's own scripts only, and its cache folder. */
function skillAccess(): { tools: string[]; dirs: string[]; hint: string } {
  const home = require('os').homedir() as string
  const fs = require('fs') as typeof import('fs')
  const names = (cfg().get<string[]>('claude.skills') ?? []).filter((x) => fs.existsSync(`${home}/.claude/skills/${x}/SKILL.md`))
  if (!names.length) return { tools: [], dirs: [], hint: '' }
  const tools = ['Skill', ...names.map((x) => `Bash(${home}/.claude/skills/${x}/scripts/*)`)]
  const dirs = names.map((x) => `${process.env.XDG_CACHE_HOME ?? `${home}/.cache`}/${x}`).filter((d) => fs.existsSync(d))
  return {
    tools, dirs,
    hint: `\n\nIf the note asks for something one of these skills does, use it: ${names.join(', ')}. Run a skill's scripts by their full path (${home}/.claude/skills/<skill>/scripts/…), one command per call: no shell variables, no && or pipes (anything else is refused). When you are done, reply with a short summary; findings you wrote as notes don't need repeating.`,
  }
}

function claudePrompt(n: Note, code: string[] | undefined): string {
  const d = n.data
  const where = d.target === 'folder' ? `the folder ${d.file}/` : d.target ? `the whole file ${d.file}` : `${d.file} lines ${d.range.start}-${d.range.end}`
  const snippet = code && !d.target ? code.slice(d.range.start - 1, d.range.end).join('\n') : ''
  const lastClaude = d.messages.map((m) => m.author === 'Claude').lastIndexOf(true)
  const rules = 'Read whatever code you need (Read, Grep, Glob); do not modify files. Reply in concise markdown; ' +
    'reference code as path:line (relative to the repository root) so it becomes a link. Your reply is posted into the note thread as is.'
  if (d.claudeSession && lastClaude >= 0) {
    const fresh = d.messages.slice(lastClaude + 1).map((m) => `${m.author}: ${m.body}`).join('\n\n')
    return `Follow-up on the same note (now on ${where}${d.stale ? ', and the code there changed' : ''}):\n\n${fresh}\n\nAnswer it. ${rules}`
  }
  return [
    `${me()} left a note on ${where} in this repository${d.stale ? ' (the code there has changed since; the note was about the lines under "Originally")' : ''}:`,
    snippet ? '```\n' + snippet + '\n```' : '',
    d.selection ? `It is about this exact text: \`${d.selection.text}\`` : '',
    d.stale && d.anchor.text ? `Originally:\n\`\`\`\n${d.anchor.text}\n\`\`\`` : '',
    'The conversation so far:',
    d.messages.map((m) => `${m.author}${m.role ? ` (${m.role})` : ''}: ${m.body}`).join('\n\n'),
    `Answer ${me()}'s latest message. ${rules}`,
  ].filter(Boolean).join('\n\n')
}

/** Failures survive a reload: kept per workspace until retried or dismissed. */
const ASK_ERR_KEY = 'codeNotes.askErrors'
const saveAskErrors = () => state.update(ASK_ERR_KEY, Object.fromEntries(askErrors))

async function askClaude(n: Note): Promise<void> {
  if (asking.has(n.data.id) || askQueue.includes(n.data.id)) return
  if (!claudeAllowed('answer notes')) return
  if (askErrors.delete(n.data.id)) void saveAskErrors()
  if (asking.size >= MAX_ASKS) { askQueue.push(n.data.id); asking.set(n.data.id, { text: '', activity: 'Queued…', started: Date.now() }); refreshAll(); return }
  await runAsk(n.data.id)
}

async function runAsk(id: string): Promise<void> {
  const n = byId(id)
  if (!n) return
  // Trust was taken back while it waited in the queue: the queue empties.
  if (!trusted()) { asking.delete(id); refreshAll(); const next = askQueue.shift(); if (next) await runAsk(next); return }
  const cli = findCli(cfg().get<string>('claude.path') || undefined)
  if (!cli) {
    asking.delete(id)
    askErrors.set(id, 'Claude Code (the `claude` CLI) was not found. Install it, or set **Code Notes › Claude: Path**.')
    log.error(`note ${id}: Ask Claude failed: the claude CLI was not found (setting codeNotes.claude.path, PATH)`)
    void saveAskErrors()
    refreshAll()
    return
  }
  const bad = modelProblem(cfg().get<string>('claude.model') || undefined)
  if (bad) {
    asking.delete(id)
    askErrors.set(id, `${bad} (setting Code Notes › Claude: Model)`)
    log.error(`note ${id}: Ask Claude not run: ${bad}`)
    void saveAskErrors()
    refreshAll()
    const next = askQueue.shift(); if (next) await runAsk(next)
    return
  }
  const entry = { text: '', activity: 'Starting Claude…', started: Date.now() } as { ask?: Ask; text: string; activity?: string; started: number; cancelled?: boolean }
  asking.set(id, entry)
  refreshAll()
  const code = n.data.target ? undefined : await linesOfUri(docUri(n))
  const skills = skillAccess()
  const ask = new Ask({
    cli, cwd: n.folder.uri.fsPath, prompt: claudePrompt(n, code) + skills.hint, resume: n.data.claudeSession,
    extraTools: skills.tools, addDirs: skills.dirs,
    model: cfg().get<string>('claude.model') || undefined,
    onProgress: (p) => { entry.text = p.text; entry.activity = p.activity; const x = byId(id); if (x) syncThread(x) },
  })
  entry.ask = ask
  if (entry.cancelled) ask.cancel() // Cancel was pressed while it was starting
  log.info(`note ${id}: asking Claude${n.data.claudeSession ? ' (follow-up)' : ''}`)
  const res = await ask.done
  asking.delete(id)
  const now2 = byId(id)
  if (res.cancelled) log.info(`note ${id}: Claude cancelled`)
  else if (res.error || !res.text.trim()) {
    askErrors.set(id, res.error ?? 'Claude returned no answer.')
    log.error(`note ${id}: Ask Claude failed: ${res.error ?? 'no answer'}`)
    void saveAskErrors()
  } else if (now2) {
    now2.data.messages.push({ author: 'Claude', role: 'agent', body: res.text.trim(), at: now() })
    if (res.sessionId) now2.data.claudeSession = res.sessionId
    shape.set(id, shapeOf(now2))
    await store.save(now2)
    log.info(`note ${id}: Claude answered in ${Math.round((Date.now() - entry.started) / 1000)}s${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    // The person is looking at this note: the answer counts as read, with its "new" label for the visit.
    if (revealedId === id) await markRead([now2], now2)
  }
  refreshAll()
  const next = askQueue.shift()
  if (next) await runAsk(next)
}

function cancelAsk(id: string): void {
  if (!asking.has(id) && askErrors.delete(id)) { void saveAskErrors(); refreshAll(); return } // Dismiss a failure
  const qi = askQueue.indexOf(id)
  if (qi >= 0) { askQueue.splice(qi, 1); asking.delete(id); refreshAll(); return }
  const a = asking.get(id)
  if (!a) return
  a.cancelled = true
  a.activity = 'Stopping…'
  a.ask?.cancel()
}

function commentsOf(n: Note, thread: vscode.CommentThread): vscode.Comment[] {
  const from = visitFrom.get(n.data.id) ?? seenCount(n)
  const out: vscode.Comment[] = []
  if (n.data.stale) {
    const a = n.data.anchor.text
    const doc = openDoc(docUri(n))
    const cur = doc && !pastEnd.has(n.data.id) ? linesOf(doc).slice(n.data.range.start - 1, n.data.range.end).join('\n') : undefined
    // Only the lines that changed, so a one-word change is visible and a 15-line note is not repeated.
    const ch = cur !== undefined ? lineDiff(a.split('\n'), cur.split('\n')) : undefined
    const short = (l: string[]) => (l.length > 3 ? [...l.slice(0, 3), `… ${l.length - 3} more`] : l)
    const was = !a.trim() && !n.data.anchor.before && !n.data.anchor.after ? ''
      : !a.trim() ? ''
      : ch && (ch.del.length || ch.ins.length) ? `\`\`\`diff\n${[...short(ch.del).map((l) => `- ${l.trim()}`), ...short(ch.ins).map((l) => `+ ${l.trim()}`)].join('\n')}\n\`\`\``
      : cur !== undefined ? '' : `\`\`\`\n${short(a.split('\n')).join('\n')}\n\`\`\``
    // Two buttons, one wording: Keep here · Move.
    const acts = `${cmdLink('Keep here', 'codeNotes.acceptCode', n.data.id)} · ${cmdLink('Move', 'codeNotes.moveToSelection', n.data.id)}`
    const branch = otherBranch(n)
    const end = pastEnd.get(n.data.id)
    out.push({
      body: (() => { const md = new vscode.MarkdownString(missing.has(n.data.id) && n.data.target ? `**\`${n.data.file}\` no longer exists.**`
        : missing.has(n.data.id) ? `**\`${n.data.file}\` no longer exists.**${was ? `\n\n${was}` : ''}\n\n${cmdLink('Move', 'codeNotes.moveToSelection', n.data.id)}`
        : end !== undefined ? `**The code changed since this note** (the file has ${end} lines now).\n\n${cmdLink('Move', 'codeNotes.moveToSelection', n.data.id)}`
        // One wording; the branch only as a fact. A code block starts on its own line.
        : `**The code changed since this note**${branch ? ` (written on \`${branch}\`)` : ''}.${was ? `\n\n${was}` : ''}\n\n${acts}`)
        md.isTrusted = { enabledCommands: ['codeNotes.acceptCode', 'codeNotes.moveToSelection'] }; return md })(),
      mode: vscode.CommentMode.Preview,
      author: { name: 'Code Notes' },
      contextValue: 'system',
    })
  }
  let prevAt = 0
  // Long threads: the first message, "N earlier replies", then the last few and everything new.
  const total = n.data.messages.length
  let hideFrom = 1, hideTo = 1
  if (total > COLLAPSE_OVER && !expanded.has(n.data.id)) {
    hideTo = Math.min(total - 3, from)
    if (hideTo - hideFrom < 2) hideTo = hideFrom
  }
  const toggle = (label: string, command: string) => out.push({
    body: systemMarkdown(cmdLink(label, command, n.data.id)), mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'system',
  })
  // Status changes: a grey line where they happened among the messages.
  const events = [...(n.data.events ?? [])]
  const flushEvents = (before?: number) => {
    while (events.length) {
      const t = Date.parse(events[0].at)
      if (before !== undefined && !(t < before)) break
      const e = events.shift()!
      out.push({
        // by the person who did it (no author-less comment).
        body: new vscode.MarkdownString(`_${e.type === 'resolved' ? 'Resolved' : 'Reopened'}_`),
        mode: vscode.CommentMode.Preview, author: { name: e.by }, timestamp: Number.isNaN(t) ? undefined : new Date(t), contextValue: 'event',
      })
    }
  }
  n.data.messages.forEach((m, i) => {
    const mt = m.at ? Date.parse(m.at) : NaN
    if (!Number.isNaN(mt)) flushEvents(mt)
    if (i >= hideFrom && i < hideTo) {
      if (i === hideFrom) toggle(`Show ${hideTo - hideFrom} earlier repl${hideTo - hideFrom === 1 ? 'y' : 'ies'}`, 'codeNotes.expandThread')
      return
    }
    if (i === 1 && expanded.has(n.data.id) && total > COLLAPSE_OVER) toggle('Show fewer', 'codeNotes.collapseThread')
    // A clock that is off (future, or before the message above): no misleading "now", the stored date instead.
    const t = m.at ? Date.parse(m.at) : NaN
    const skewed = !Number.isNaN(t) && (t > Date.now() + 60_000 || t < prevAt - 60_000)
    if (!Number.isNaN(t) && !skewed) prevAt = Math.max(prevAt, t)
    out.push({
    body: messageMarkdown(n, m.body, isAgent(m) ? i : undefined, i),
    mode: vscode.CommentMode.Preview,
    author: { name: m.author }, // no placeholder avatar: the name says who
    timestamp: !Number.isNaN(t) && !skewed ? new Date(t) : undefined,
    label: [i >= seenCount(n) && !mine(m) ? 'new' : '', skewed ? `dated ${m.at!.slice(0, 10)}` : ''].filter(Boolean).join(' · ') || undefined,
    contextValue: 'message',
    parent: thread,
  } as vscode.Comment)
  })
  flushEvents()
  const a = asking.get(n.data.id)
  if (a) {
    const secs = Math.round((Date.now() - a.started) / 1000)
    out.push({
      body: systemMarkdown(`${a.text || ''}${a.activity ? `${a.text ? '\n\n' : ''}_${a.activity}_` : ''}${!a.text && !a.activity ? '_Thinking…_' : ''}\n\n${cmdLink('Cancel', 'codeNotes.cancelClaude', n.data.id)}`),
      mode: vscode.CommentMode.Preview, author: { name: 'Claude' }, label: secs > 2 ? `answering… ${secs}s` : 'answering…', contextValue: 'system',
    })
  }
  const err = askErrors.get(n.data.id)
  // A failure is a passing status, not a message from Claude: Try again, or Dismiss; never saved.
  if (err) out.push({ body: systemMarkdown(`⚠ Claude couldn't answer: ${err}\n\n${cmdLink('Try again', 'codeNotes.askClaude', n.data.id)} · ${cmdLink('Dismiss', 'codeNotes.cancelClaude', n.data.id)}`), mode: vscode.CommentMode.Preview, author: { name: 'Code Notes' }, contextValue: 'system' })
  return out
}

/**
 * A new comment thread's first state reaches the workbench ~100 ms after it was made (the extension host debounces
 * thread updates, and every change restarts that wait). Until then the thread has no collapsed state there, and a
 * second comment widget for it (another editor on the file, the editor showing it again) makes VS Code loop between
 * the thread's collapsibleState and initialCollapsibleState ("Maximum call stack size exceeded"; the widget ends up
 * collapsed). So a thread gets all its properties in the tick it is made, then nothing for SETTLE_MS; and a property is
 * only ever set when its value changes (setting an equal one still counts as a change and restarts the wait).
 */
const SETTLE_MS = 160
const bornAt = new WeakMap<vscode.CommentThread, number>()
function newThread(c: vscode.CommentController, uri: vscode.Uri, range: vscode.Range): vscode.CommentThread {
  const t = c.createCommentThread(uri, range, [])
  bornAt.set(t, Date.now())
  return t
}
/**
 * When each file's editor last came on screen. A thread made for a file whose editor is just opening gets a second
 * widget from that editor before its first state arrives (the same loop): it is made once the editor has settled.
 */
const editorShownAt = new Map<string, number>()
let visibleBefore = new Set<string>()
function noteVisibleEditors(): void {
  const now = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()))
  for (const u of now) if (!visibleBefore.has(u)) editorShownAt.set(u, Date.now())
  visibleBefore = now
}
/** Milliseconds until a thread may be made on this file (0: now). */
function editorSettling(uri: vscode.Uri): number {
  noteVisibleEditors()
  const t = editorShownAt.get(uri.toString())
  return t === undefined ? 0 : Math.max(0, t + SETTLE_MS - Date.now())
}
/** Milliseconds until a thread made just now may change again (0: it may). */
function settling(t: vscode.CommentThread): number {
  const b = bornAt.get(t)
  return b === undefined ? 0 : Math.max(0, b + SETTLE_MS - Date.now())
}
/** Runs `fn` now, or once the thread has settled (the last call per key wins). */
const settleLater = new Map<string, NodeJS.Timeout>()
function whenSettled(t: vscode.CommentThread, key: string, fn: () => void): void {
  const wait = settling(t)
  clearTimeout(settleLater.get(key))
  settleLater.delete(key)
  if (!wait) { fn(); return }
  settleLater.set(key, setTimeout(() => { settleLater.delete(key); fn() }, wait))
}
/** Sets a thread property only when it differs (each set restarts the extension host's update wait). */
function setThread<K extends 'canReply' | 'contextValue' | 'label' | 'collapsibleState'>(t: vscode.CommentThread, k: K, v: vscode.CommentThread[K]): void {
  if (t[k] !== v) t[k] = v
}
function setCollapse(t: vscode.CommentThread, v: vscode.CommentThreadCollapsibleState, key: string): void {
  whenSettled(t, `collapse:${key}`, () => setThread(t, 'collapsibleState', v))
}

/** What each thread last rendered (see syncThread). */
const shown = new Map<string, string>()

function syncThread(n: Note): void {
  const showResolvedInEditor = cfg().get<boolean>('showResolvedInEditor', false)
  let t = threads.get(n.data.id)
  const wanted = ((n.data.status === 'open' || showResolvedInEditor || unread(n) > 0 || revealedId === n.data.id) && !hiddenInEditor(n)) || asking.has(n.data.id) || askErrors.has(n.data.id)
  if (!wanted) {
    if (t) { t.dispose(); threads.delete(n.data.id); shown.delete(n.data.id) }
    return
  }
  if (!t || t.uri.toString() !== docUri(n).toString()) {
    const wait = editorSettling(docUri(n))
    if (wait) { const id = n.data.id; clearTimeout(settleLater.get(`new:${id}`)); settleLater.set(`new:${id}`, setTimeout(() => { settleLater.delete(`new:${id}`); const x = byId(id); if (x) syncThread(x) }, wait)); return }
    t?.dispose()
    shown.delete(n.data.id)
    t = newThread(controller, docUri(n), threadRange(n))
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed
    threads.set(n.data.id, t)
  } else if (settling(t)) {
    // Made just now: its first state is still on the way to the workbench; this update follows once it is there.
    const id = n.data.id
    whenSettled(t, `sync:${id}`, () => { const x = byId(id); if (x) syncThread(x) })
    return
  }
  const r = threadRange(n)
  if (!t.range || !t.range.isEqual(r)) t.range = r
  // Rebuilding comments re-renders the widget: only when something shown changed (an agent reply elsewhere must be cheap).
  const sig = JSON.stringify([stepLinkOf(n) ? `${tourKey}|${touring()}|${tourId}` : '', n.data.messages.length, n.data.messages[n.data.messages.length - 1]?.body.length, n.data.status, n.data.stale, n.data.events?.length, n.data.target,
    missing.has(n.data.id), pastEnd.get(n.data.id), n.data.stale && openDoc(docUri(n))?.version, seenCount(n), visitFrom.get(n.data.id), expanded.has(n.data.id), otherBranch(n) ?? '', n.data.anchor.text.length,
    asking.get(n.data.id)?.text.length, asking.get(n.data.id)?.activity, asking.has(n.data.id) && Math.floor((Date.now() - asking.get(n.data.id)!.started) / 5000), askErrors.get(n.data.id)])
  if (shown.get(n.data.id) !== sig) { t.comments = commentsOf(n, t); shown.set(n.data.id, sig) }
  setThread(t, 'canReply', true)
  const st = n.data.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved
  if (t.state !== st) t.state = st
  setThread(t, 'contextValue', ['note', n.data.status, n.data.stale ? 'stale' : '', asking.has(n.data.id) ? 'asking' : ''].filter(Boolean).join(';'))
  // Question, replies, Reply: the header says only what the gutter can't — a file or folder note,
  // or that its file is missing. Severity, session, "n new" and "resolved" are in the list and VS Code's own state.
  setThread(t, 'label', [
    n.data.target === 'folder' ? `Folder ${n.data.file}/` : n.data.target ? 'File note' : '',
    missing.has(n.data.id) ? `⚠ ${n.data.target === 'folder' ? 'folder' : 'file'} not found` : '',
    // The note's first line: never VS Code's "Start discussion".
    shortQ((n.data.messages[0]?.body ?? '').split('\n').find((l) => l.trim()) ?? '', 80),
  ].filter(Boolean).join(' · '))
}

function noteOfThread(t: vscode.CommentThread): Note | undefined {
  for (const [id, th] of threads) if (th === t) return byId(id)
  return undefined
}

// ---------- sidebar ----------

type Node =
  | { kind: 'session'; name: string; notes: Note[] }
  | { kind: 'file'; key: string; folder: vscode.WorkspaceFolder; file: string; notes: Note[]; session?: string; isFolder?: boolean }
  | { kind: 'note'; note: Note }
  | { kind: 'broken'; uri: string; why: string }
  | { kind: 'journeys' }
  | { kind: 'journey'; lj: LoadedJourney }
  | { kind: 'badJourney'; uri: vscode.Uri; why: string }
  | { kind: 'intro' }
  | { kind: 'questions'; lj: LoadedJourney; notes: Note[] }

const lastMessage = (n: Note) => n.data.messages[n.data.messages.length - 1]

function matchesFilter(n: Note): boolean {
  const open = n.data.status === 'open'
  switch (filter) {
    case 'unread': return unread(n) > 0 || revealedId === n.data.id
    case 'needsMe': return open && !!lastMessage(n) && !mine(lastMessage(n)!)
    case 'waiting': return open && !!lastMessage(n) && mine(lastMessage(n)!)
    case 'stale': return !!n.data.stale && (open || showResolved)
    default: return open || showResolved || unread(n) > 0
  }
}

/** One line of a markdown message, as plain text. */
function plain(s: string, max = 80): string {
  const l = (s.split('\n').find((x) => x.trim()) ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(#+|>)\s*/, '').replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2').replace(/\s+/g, ' ').trim()
  return l.length > max ? l.slice(0, max - 1) + '…' : l
}

function ago(at?: string): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

const order = (a: Note, b: Note) => a.data.range.start - b.data.range.start || (a.data.createdAt ?? a.data.id).localeCompare(b.data.createdAt ?? b.data.id)
/** Most severe first; a note without a severity counts as medium. */
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, nit: 3 }
const sevRank = (n: Note) => SEV_RANK[n.data.severity ?? 'medium']
/** The sidebar's order inside a group: severity, then the whole-file note, then by line. */
const rowOrder = (a: Note, b: Note) => sevRank(a) - sevRank(b) || (a.data.target ? 0 : 1) - (b.data.target ? 0 : 1) || order(a, b)
const SEV_ICON: Record<Severity, [string, string]> = { high: ['flame', 'charts.red'], medium: ['triangle-up', 'charts.orange'], low: ['triangle-down', 'charts.blue'], nit: ['dash', 'descriptionForeground'] }

const sessionOf = (n: Note) => n.data.session ?? ''
const HIDDEN_KEY = 'codeNotes.hiddenSessions'
function hiddenSessions(): Set<string> { return new Set(state.get<string[]>(HIDDEN_KEY) ?? []) }
/** A note whose session is hidden is not drawn in the editor (unless it was just opened from the list). */
const hiddenInEditor = (n: Note) => revealedId !== n.data.id && hiddenSessions().has(sessionOf(n))
/** Hides or shows sessions; `only` shows these and hides every other one. */
async function setSessionHidden(names: string[], hidden: boolean, only = false): Promise<void> {
  const h = only ? new Set(notes().map(sessionOf).filter((x) => !names.includes(x))) : hiddenSessions()
  if (!only) for (const name of names) hidden ? h.add(name) : h.delete(name)
  await state.update(HIDDEN_KEY, [...h])
  const r = revealedId ? byId(revealedId) : undefined
  if (r && h.has(sessionOf(r))) { revealedId = undefined; const t = threads.get(r.data.id); if (t) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, r.data.id) }
  refreshAll()
}

/** One object per tree element (TreeView.reveal finds elements by identity). */
const nodes = new Map<string, Node>()
function cached<T extends Node>(key: string, fresh: T): T {
  const c = nodes.get(key)
  if (!c) { nodes.set(key, fresh); return fresh }
  for (const k of Object.keys(c)) delete (c as any)[k]
  return Object.assign(c, fresh) as T
}
const noteNode = (note: Note) => cached(`note:${note.data.id}`, { kind: 'note', note })

/** Notes grouped by file (or folder); a file with one note is that note's row. */
function fileGroups(list: Note[], session?: string): Node[] {
  const groups = new Map<string, Node & { kind: 'file' }>()
  for (const n of list) {
    const key = `${session ?? ''}|${n.folder.uri}|${n.data.file}`
    if (!groups.has(key)) groups.set(key, cached(`file:${key}`, { kind: 'file', key, folder: n.folder, file: n.data.file, notes: [], ...(session !== undefined ? { session } : {}), ...(n.data.target === 'folder' ? { isFolder: true } : {}) }))
    groups.get(key)!.notes.push(n)
  }
  // A stable order: the list must not jump while an agent writes; unread shows as dots.
  // In a session (a review): the most severe findings first, then by file.
  const worst = (g: { notes: Note[] }) => (session !== undefined ? Math.min(...g.notes.map(sevRank)) : 0)
  return [...groups.values()].sort((a, b) => worst(a) - worst(b) || a.file.localeCompare(b.file)).map((g) => (g.notes.length === 1 ? noteNode(g.notes[0]) : g))
}

/** Group by session (when there are sessions and the person chose it). */
const bySessions = () => groupMode === 'session' && notes().some((x) => x.data.session)
/** The session group a note is listed under, if any. */
function scopeOf(n: Note): string | undefined {
  return bySessions() ? sessionOf(n) : undefined
}
const sessionNode = (name: string) => cached(`session:${name}`, { kind: 'session' as const, name, notes: notes().filter((x) => sessionOf(x) === name && matchesFilter(x)) })
/** The visible notes listed with this one under the same file row (itself included). */
function sameRow(n: Note): Note[] {
  const scope = scopeOf(n)
  return notes().filter((x) => x.folder === n.folder && x.data.file === n.data.file && matchesFilter(x) && scopeOf(x) === scope && !journeyOfNote(x))
}
/** A row of its own: alone in its file. */
const ownRow = (n: Note) => sameRow(n).length <= 1

class NotesTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  refresh() { this.changed.fire(undefined) }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'file') return [...node.notes].sort(rowOrder).map(noteNode)
    if (node?.kind === 'session') return fileGroups(node.notes, node.name)
    if (node?.kind === 'journeys') return journeyRows()
    if (node?.kind === 'journey') { const q = questionsNode(node.lj); return q && q.kind === 'questions' ? [...q.notes].sort(order).map(noteNode) : [] }
    if (node?.kind === 'questions') return [...node.notes].sort(order).map(noteNode)
    if (node) return []
    // Questions asked from a step are listed under their journey, not as loose rows.
    const visibleNotes = notes().filter((n) => matchesFilter(n) && !journeyOfNote(n))
    const broken: Node[] = [...store.broken].map(([uri, why]) => ({ kind: 'broken', uri, why }))
    // Journeys: one collapsed group (reading material, not an inbox:-), above the notes.
    // Notes first (they may need you), then the journeys; a notes filter hides the journeys.
    const js: Node[] = hasJourneyRows() && filter === 'all' ? [journeysNode()] : []
    const grouped = visibleNotes.filter((n) => scopeOf(n) !== undefined)
    const loose = visibleNotes.filter((n) => scopeOf(n) === undefined)
    if (!grouped.length) return [...broken, ...fileGroups(loose), ...js]
    // Sessions: newest first; notes without one are under "Notes".
    const bySession = new Map<string, Note[]>()
    for (const n of grouped) bySession.set(sessionOf(n), [...(bySession.get(sessionOf(n)) ?? []), n])
    const latest = (list: Note[]) => list.map((n) => n.data.createdAt ?? n.data.id).sort().pop() ?? ''
    const hasNew = (list: Note[]) => (list.some((n) => unread(n) > 0) ? 0 : 1)
    const sessions = [...bySession].map(([name, list]) => cached(`session:${name}`, { kind: 'session' as const, name, notes: list }))
      .sort((x, y) => hasNew(x.notes) - hasNew(y.notes) || latest(y.notes).localeCompare(latest(x.notes)))
    return [...broken, ...sessions, ...fileGroups(loose), ...js]
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'journey' || node.kind === 'intro' || node.kind === 'badJourney') return journeysNode()
    if (node.kind === 'questions') return journeyNode(node.lj)
    if (node.kind === 'note') { const lj = journeyOfNote(node.note); if (lj) return journeyNode(lj) }
    if (node.kind === 'file' && node.session !== undefined) {
      return cached(`session:${node.session}`, { kind: 'session', name: node.session, notes: notes().filter((x) => sessionOf(x) === node.session && matchesFilter(x)) })
    }
    if (node.kind !== 'note') return undefined
    const n = node.note
    const scope = scopeOf(n)
    if (ownRow(n)) return scope !== undefined ? sessionNode(scope) : undefined
    const key = `${scope ?? ''}|${n.folder.uri}|${n.data.file}`
    return cached(`file:${key}`, { kind: 'file', key, folder: n.folder, file: n.data.file, notes: sameRow(n), ...(scope !== undefined ? { session: scope } : {}), ...(n.data.target === 'folder' ? { isFolder: true } : {}) })
  }

  /** What the person expanded or folded, by row id: kept when a filter hides and brings rows back. */
  readonly folded = new Map<string, vscode.TreeItemCollapsibleState>()
  getTreeItem(node: Node): vscode.TreeItem {
    const it = this.itemOf(node)
    const st = it.id ? this.folded.get(it.id) : undefined
    if (st !== undefined && it.collapsibleState !== undefined && it.collapsibleState !== vscode.TreeItemCollapsibleState.None) it.collapsibleState = st
    return it
  }
  private itemOf(node: Node): vscode.TreeItem {
    if (node.kind === 'journeys') {
      // Open the first time (with one quiet line saying what it is: R1), then folded: reading material, not an inbox.
      const item = new vscode.TreeItem('Journeys', (tourJourney() && tourStep) || showIntro() ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      // Its name only: the rows below are the count and the explanation.
      item.id = 'journeys'
      item.contextValue = 'journeys'
      return item
    }
    if (node.kind === 'intro') {
      const item = new vscode.TreeItem('Journeys explain how the code works')
      item.id = 'journeys-intro'
      item.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'))
      item.tooltip = 'Each one answers a question with a map of the code and its steps. Click one to open its map.'
      return item
    }
    if (node.kind === 'journey') return journeyItem(node.lj)
    if (node.kind === 'badJourney') {
      // Never readable: one dimmed row (the text is the row's muted description), why on hover, click opens it.
      const name = node.uri.path.split('/').pop()!
      const item = new vscode.TreeItem('')
      item.id = `badJourney:${node.uri}`
      item.description = `⚠ ${name}`
      const tip = new vscode.MarkdownString(`${node.why.replace(/[\\`*_[\]<>]/g, '\\$&')}\n\n[Open file](command:vscode.open?${encodeURIComponent(JSON.stringify([node.uri.toString()]))})`)
      tip.isTrusted = { enabledCommands: ['vscode.open'] }
      item.tooltip = tip
      item.accessibilityInformation = { label: `${name}: can't be read` }
      item.command = { command: 'vscode.open', title: 'Open file', arguments: [node.uri] }
      item.contextValue = 'badJourney'
      return item
    }
    if (node.kind === 'questions') {
      const item = new vscode.TreeItem(`Questions (${node.notes.length})`, vscode.TreeItemCollapsibleState.Expanded)
      item.id = `questions:${node.lj.key}`
      item.iconPath = new vscode.ThemeIcon('comment-discussion')
      const u = node.notes.filter((n) => unread(n) > 0).length
      if (u) item.description = `${u} new`
      item.tooltip = 'Notes asked from this journey\'s steps'
      return item
    }
    if (node.kind === 'session') {
      const hidden = hiddenSessions().has(node.name)
      const item = new vscode.TreeItem(node.name || 'Notes', hidden ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
      item.id = `session:${node.name}`
      const u = node.notes.filter((n) => unread(n) > 0).length
      const all = notes().filter((n) => sessionOf(n) === node.name)
      const done = all.filter((n) => n.data.status === 'resolved').length
      item.description = [`${node.notes.length}`, u ? `${u} new` : '', done ? `${done}/${all.length} resolved` : '', hidden ? 'hidden' : ''].filter(Boolean).join(' · ')
      item.iconPath = new vscode.ThemeIcon(hidden ? 'eye-closed' : 'notebook')
      item.contextValue = `session;${hidden ? 'hidden' : 'shown'}${node.name ? ';named' : ''}`
      item.tooltip = hidden ? 'Hidden in the editor' : 'Shown in the editor'
      item.accessibilityInformation = { label: `${node.name || 'Notes'}, ${item.description}, ${hidden ? 'hidden in' : 'shown in'} the editor` }
      return item
    }
    if (node.kind === 'broken') {
      const known = store.notes.get(node.uri)
      const name = vscode.Uri.parse(node.uri).path.split('/').pop() ?? node.uri
      const title = store.brokenTitle.get(node.uri) ?? known?.data.messages[0]?.body
      const item = new vscode.TreeItem(title ? plain(title, 50) : name)
      item.id = `broken:${node.uri}`
      item.description = `⚠ ${node.why}`
      item.tooltip = new vscode.MarkdownString(`**${name}**: ${node.why}${known ? `\n\nThe list shows its last good version (\`${known.data.file}\` ${lines(known)}).` : ''}`)
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      item.contextValue = known ? 'broken;known' : 'broken'
      item.command = { command: 'codeNotes.openBroken', title: 'Open', arguments: [node] }
      return item
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.file.split('/').pop() ?? node.file, vscode.TreeItemCollapsibleState.Expanded)
      item.id = `file:${node.key}`
      const dir = node.file.includes('/') ? node.file.slice(0, node.file.lastIndexOf('/')) : ''
      const u = node.notes.filter((n) => unread(n) > 0).length
      const st = node.notes.filter((n) => n.data.stale).length
      const newMsgs = node.notes.reduce((a, n) => a + unread(n), 0)
      const segs = dir.split('/').filter(Boolean)
      const shortDir = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : dir
      item.description = [`${node.notes.length}`, newMsgs ? `${newMsgs} new` : '', st ? `${st} stale` : '', shortDir].filter(Boolean).join(' · ')
      // A query keeps VS Code's Problems/git decorations off the row while the file icon still follows the extension.
      item.resourceUri = vscode.Uri.joinPath(node.folder.uri, node.file).with({ query: 'code-notes' })
      item.iconPath = node.isFolder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File
      item.contextValue = 'file'
      item.tooltip = node.file
      return item
    }
    const n = node.note
    const d = n.data
    const u = unread(n)
    const gone = missing.has(d.id)
    const link = stepLinkOf(n)
    const item = new vscode.TreeItem({ label: `${u && d.stale ? '⚠ ' : ''}${link && journeyOfNote(n) ? `Step ${link.n} · ` : ''}${isolate(plain(d.messages[0]?.body ?? '(empty note)', 60))}` })
    item.id = `note:${d.id}`
    const replies = d.messages.length - 1
    // Alone in its file: the row says which file (`app.ts:12`), there is no file row above it.
    const base = d.file.split('/').pop() ?? d.file
    const where = !ownRow(n) ? lines(n) : d.target === 'folder' ? `${base}/` : d.target ? base : `${base}:${d.range.start}`
    // State first: it must survive truncation at the default sidebar width.
    item.description = [
      u ? `${u} new` : '',
      asking.has(d.id) ? (asking.get(d.id)!.activity === 'Queued…' ? 'queued for Claude' : 'Claude is answering…') : askErrors.has(d.id) ? 'Claude failed' : '',
      gone ? 'file not found' : d.stale ? 'stale' : '',
      d.status === 'resolved' ? 'resolved' : '',
      where,
      !u && replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '',
    ].filter(Boolean).join(' · ')
    item.iconPath = asking.has(d.id) ? new vscode.ThemeIcon('sync~spin')
      : askErrors.has(d.id) ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      // An open finding shows its severity even while unread (a fresh review is all unread; "n new" says so).
      : d.severity && d.status === 'open' && !d.stale ? new vscode.ThemeIcon(SEV_ICON[d.severity][0], new vscode.ThemeColor(SEV_ICON[d.severity][1]))
      : u ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codeNotes.unreadForeground'))
      : gone ? new vscode.ThemeIcon('error', new vscode.ThemeColor('editorWarning.foreground'))
      : d.stale ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
      : d.status === 'resolved' ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      // Who spoke last: you (waiting on the agent) or an agent (your turn).
      : lastMessage(n) && mine(lastMessage(n)!) ? new vscode.ThemeIcon('person')
      : new vscode.ThemeIcon('sparkle')
    const first = d.messages[0]
    const last = lastMessage(n)
    const tip = new vscode.MarkdownString()
    // The newest reply first: it is what changed; the row itself stays the question.
    if (last && last !== first) tip.appendMarkdown(`**${last.author}** ${ago(last.at)}\n\n${plain(last.body, 300)}\n\n---\n\n`)
    if (first) tip.appendMarkdown(`${d.messages.length > 2 ? `_${d.messages.length - 2} more · _` : ''}**${first.author}** ${ago(first.at)}\n\n${plain(first.body, 300)}\n\n`)
    const ev = d.events?.[d.events.length - 1]
    if (ev) tip.appendMarkdown(`_${ev.type === 'resolved' ? 'Resolved' : 'Reopened'} by ${ev.by} ${ago(ev.at)}_\n\n`)
    if (d.severity) tip.appendMarkdown(`Severity: ${d.severity}\n\n`)
    if (d.stale) tip.appendMarkdown(`---\n\n⚠ ${gone ? `The ${d.target === 'folder' ? 'folder' : 'file'} no longer exists.` : 'The code changed since this note.'}`)
    item.tooltip = tip
    item.command = { command: 'codeNotes.reveal', title: 'Go to Note', arguments: [node] }
    // `asking` (Stop Claude only then), the status (no Ask Claude on a resolved note).
    item.contextValue = ['note', d.status, d.stale ? 'stale' : '', u ? 'unread' : '', d.messages.some((m) => !mine(m)) ? 'replied' : '', asking.has(d.id) ? 'asking' : ''].filter(Boolean).join(';')
    // No checkbox on every row: bulk actions use the list's own multi-select (Ctrl/Shift+click).
    return item
  }
}

// ---------- refresh ----------

function refreshDecorations(): void {
  const on = cfg().get<boolean>('highlight', true)
  for (const editor of vscode.window.visibleTextEditors) {
    const list = on ? lineNotesFor(editor.document.uri).filter((n) => (n.data.status === 'open' || unread(n) > 0) && !hiddenInEditor(n)) : []
    const range = (n: Note) => new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
    // Big notes (a function, a whole file) get the left bar only, so they don't flood the code or hide notes inside them.
    // One marker per note (–): the left bar and the scrollbar mark, never a tint over its lines.
    const big = (_n: Note) => true
    editor.setDecorations(deco.open, list.filter((n) => !n.data.stale && !big(n)).map(range))
    editor.setDecorations(deco.openBar, list.filter((n) => !n.data.stale && big(n)).map(range))
    editor.setDecorations(deco.stale, list.filter((n) => n.data.stale && !big(n)).map(range))
    editor.setDecorations(deco.staleBar, list.filter((n) => n.data.stale && big(n)).map(range))
    editor.setDecorations(deco.unread, list.filter((n) => unread(n) > 0).map(range))
    // The exact text a note is about, where it still is on the note's lines.
    const exact: vscode.Range[] = []
    for (const n of list) {
      const sel = n.data.selection
      if (!sel || n.data.stale) continue
      const text = editor.document.getText(range(n).with({ end: new vscode.Position(n.data.range.end - 1, Number.MAX_SAFE_INTEGER) }))
      const at = text.indexOf(sel.text)
      if (at >= 0) exact.push(new vscode.Range(editor.document.positionAt(editor.document.offsetAt(range(n).start) + at), editor.document.positionAt(editor.document.offsetAt(range(n).start) + at + sel.text.length)))
    }
    editor.setDecorations(deco.exact, exact)
  }
  refreshStepDecorations()
}

function updateCursorContext(): void {
  const e = vscode.window.activeTextEditor
  const line = e ? e.selection.active.line + 1 : -1
  setCtx('codeNotes.cursorOnNote', !!e && notesFor(e.document.uri).some((n) => line >= n.data.range.start && line <= n.data.range.end))
}

function refreshAll(): void {
  for (const n of notes()) syncThread(n)
  const ids = new Set(notes().map((n) => n.data.id))
  for (const id of [...threads.keys()]) if (!ids.has(id)) { threads.get(id)!.dispose(); threads.delete(id) }
  for (const id of [...checked]) if (!ids.has(id)) checked.delete(id)
  tree.refresh()
  const u = notes().filter((n) => unread(n) > 0).length
  treeView.badge = u ? { value: u, tooltip: `${u} note${u === 1 ? '' : 's'} with new replies` } : undefined
  // An active filter is visible: view title, a message, a filled filter icon.
  const shownCount = notes().filter(matchesFilter).length
  const label = FILTERS.find((f) => f.id === filter)!.label
  treeView.description = filter === 'all' ? undefined : `${label} · ${shownCount}`
  treeView.message = [
    store.broken.size ? `${store.broken.size} note file${store.broken.size === 1 ? '' : 's'} can't be used (top of the list)` : '',
    filter !== 'all' && !shownCount ? `No notes match "${label}".` : '',
    filter !== 'all' && journeys.list.size ? 'Journeys are hidden while filtering.' : '',
  ].filter(Boolean).join(' ') || undefined
  setCtx('codeNotes.hasNotes', ids.size > 0 || store.broken.size > 0)
  setCtx('codeNotes.hasChecked', checked.size > 0)
  setCtx('codeNotes.filtered', filter !== 'all')
  setCtx('codeNotes.groupBy', groupMode)
  setCtx('codeNotes.hasSessions', notes().some((n) => n.data.session))
  setCtx('codeNotes.hasHiddenSessions', notes().some((n) => hiddenSessions().has(sessionOf(n))))
  if (asking.size) {
    statusItem.text = `$(sync~spin) Claude · ${asking.size}`
    statusItem.tooltip = `Claude is answering ${asking.size} note${asking.size === 1 ? '' : 's'}`
    statusItem.command = 'codeNotes.notes.focus'
    statusItem.show()
  } else statusItem.hide() // no note counter: the activity bar badge is the one unread count
  refreshDecorations()
  updateCursorContext()
  updateTour()
}

// ---------- journeys: a map, a storyline and a tour of read-only steps (journeys.ts, journeyModel.ts) ----------

/** The map column's width in wide panels, as last dragged (0.21.1): every panel, every journey. */
const MAP_WIDTH_KEY = 'codeNotes.mapWidth'
const tourJourney = () => (tourKey ? journeys.list.get(tourKey) : undefined)
/** A tour is running (not just a map open): only then the status bar, the step card and D/A belong to it. */
const touring = () => !!tourJourney() && tourStep > 0

type Pos = { step: number; id?: string; at: string }
const positions = () => state.get<Record<string, Pos>>(POS_KEY) ?? {}
/** Where this journey was left (0: never started): the same step by id when it still exists, else the same number. */
function resumeAt(lj: LoadedJourney): number {
  const p = positions()[posKey(lj)]
  if (!p) return 0
  const i = p.id ? lj.j.steps.findIndex((s) => s.id === p.id) : -1
  return i >= 0 ? i + 1 : Math.min(p.step, lj.j.steps.length)
}
async function savePos(lj: LoadedJourney, step: number): Promise<void> {
  await state.update(POS_KEY, { ...positions(), [posKey(lj)]: { step, id: lj.j.steps[step - 1]?.id, at: now() } })
}

/** The journey file changed during a tour: stay on the same step (by id); if it was removed, its neighbour. */
function followStep(): void {
  const lj = tourJourney()
  if (!lj || !tourStep) return
  const i = lj.j.steps.findIndex((s) => s.id === tourId)
  if (i >= 0) { if (tourStep !== i + 1) vscode.window.setStatusBarMessage(`$(info) Journey updated: this step is now ${i + 1}/${lj.j.steps.length}`, 5000); tourStep = i + 1 }
  else {
    if (!lj.j.steps.length) { void endTour(); return }
    tourStep = Math.min(tourStep, lj.j.steps.length)
    tourId = lj.j.steps[tourStep - 1].id
    // Said on the card, where the eyes are, and the editor goes with it.
    cardNotice = { id: tourId, text: `The step you were on was removed from the journey. This is the next one (${tourStep}/${lj.j.steps.length}).` }
    vscode.window.setStatusBarMessage(`$(info) The step you were on was removed from the journey: now at ${tourStep}/${lj.j.steps.length}`, 5000)
  }
  void savePos(lj, tourStep)
  if (i < 0) { void goToStep(lj, tourStep, { focus: false }); return } // map, card AND editor on the new step
  // The agent re-anchored this step (other file or lines): the editor follows the card, with one line saying so.
  const s = lj.j.steps[i], was = shownAt
  if (was && was.key === lj.key && was.id === s.id) {
    void journeys.locate(lj, (k) => k === i + 1).then(() => {
      const at = lj.at[i], f = fileOf(lj, i + 1)
      if (tourStep !== i + 1 || tourJourney() !== lj) return
      // Only a change in the journey file is "updated": code that moved or came back is just shown, no notice.
      const rewritten = wroteAt(lj, i + 1) !== was.wrote
      const elsewhere = f !== was.file || at.start !== was.start || at.end !== was.end || !!at.removed !== was.removed
      if (!rewritten && cardNotice?.id === s.id) cardNotice = undefined
      if (rewritten && elsewhere) {
        cardNotice = { id: s.id, text: `This step was updated: its code is now at ${f.split('/').pop()}:${at.start}.` }
        void goToStep(lj, i + 1, { focus: false })
      } else if (elsewhere) void goToStep(lj, i + 1, { focus: false })
      else { showCard(lj, tourStep); updateTour() }
    })
    tree.refresh()
    return
  }
  showCard(lj, tourStep)
  updateTour()
  tree.refresh()
}

/** Step number -> 'stale' (its code can't be found), for the map. */
function stepMarks(lj: LoadedJourney): Record<number, string> {
  const out: Record<number, string> = {}
  lj.at.forEach((a, i) => { if (a.stale) out[i + 1] = 'stale' })
  return out
}

/** "3/13", "at 3/13" (left there), "13 steps". */
function progress(lj: LoadedJourney): string {
  const total = lj.j.steps.length
  if (lj.key === tourKey && tourStep) return `${tourStep}/${total}`
  const r = resumeAt(lj)
  return r ? `at ${r}/${total}` : `${total} step${total === 1 ? '' : 's'}`
}

const journeysNode = () => cached('journeys', { kind: 'journeys' as const })
const journeyNode = (lj: LoadedJourney) => cached(`journey:${lj.key}`, { kind: 'journey' as const, lj })
/** Alphabetical by title, always (R1): the list never jumps when a journey starts or a new one arrives. */
const journeyOrder = (): LoadedJourney[] => journeys.all()
const journeyRows = (): Node[] => [...journeyOrder().map(journeyNode),
  ...[...journeys.invalid.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path)).map((x) => cached(`badJourney:${x.uri}`, { kind: 'badJourney' as const, uri: x.uri, why: x.why }))]
const hasJourneyRows = () => journeys.list.size + journeys.invalid.size > 0

/** Journeys seen in the list (posKeys); one added since is "new" until opened (R1). Unset: everything there now is known. */
const SEEN_J_KEY = 'codeNotes.journeysSeen'
function seenJourneys(): Set<string> | undefined { const v = state.get<string[]>(SEEN_J_KEY); return v ? new Set(v) : undefined }
const isNewJourney = (lj: LoadedJourney) => { const s = seenJourneys(); return !!s && !s.has(posKey(lj)) }
async function markJourneysSeen(only?: LoadedJourney): Promise<void> {
  const s = seenJourneys()
  if (s && only) { if (s.has(posKey(only))) return; s.add(posKey(only)); await state.update(SEEN_J_KEY, [...s]); return }
  if (!s) await state.update(SEEN_J_KEY, journeys.all().map(posKey))
}
/** The quiet line under the group, until a journey has been opened once. */
const INTRO_KEY = 'codeNotes.journeyOpened'
const showIntro = () => !gstate.get<boolean>(INTRO_KEY)
/** Text in a Unicode isolate (FSI…PDI) when it holds right-to-left letters; plain text stays as it is. */
const isolate = (t: string) => (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(t) ? `\u2068${t}\u2069` : t)

/** The step a note was asked from: `extra.journey` = { id, step, n }. */
function stepLinkOf(n: Note): { id: string; step?: string; n: number } | undefined {
  const v = n.data.extra?.journey as any
  return v && typeof v.id === 'string' && Number.isInteger(v.n) ? v : undefined
}
function journeyOfNote(n: Note): LoadedJourney | undefined {
  const l = stepLinkOf(n)
  if (!l) return undefined
  return [...journeys.list.values()].find((x) => x.j.id === l.id && x.folder.uri.toString() === n.folder.uri.toString())
}
/**
 * Step n -> its questions: the note to open (the first unread, else the newest), whether any was answered
 * ('a') or not ('q'), how many there are and how many were answered. Resolved ones don't count.
 */
type Asked = { id: string; state: 'q' | 'a'; unread: boolean; count: number; answered: number; update: boolean }
function askedOf(lj: LoadedJourney): Record<number, Asked> {
  const out: Record<number, Asked> = {}
  for (const n of notes().sort(order)) {
    if (journeyOfNote(n) !== lj || n.data.status !== 'open') continue
    const l = stepLinkOf(n)!
    const i = l.step ? lj.j.steps.findIndex((s) => s.id === l.step) : l.n - 1
    if (i < 0) continue
    const a = n.data.messages.some((m) => !mine(m)), u = unread(n) > 0
    const o = out[i + 1] ?? { id: n.data.id, state: 'q', unread: false, count: 0, answered: 0, update: false }
    o.count++
    if (a) { o.answered++; o.state = 'a' }
    if (u && !o.unread) { o.unread = true; o.id = n.data.id } else if (!o.unread) o.id = n.data.id
    if (n.data.messages[0]?.body.startsWith(UPDATE_ASK.slice(0, 30))) o.update = true
    out[i + 1] = o
  }
  return out
}
/** "2 questions · 1 answered". */
const askedText = (a: Asked) => `${a.count} question${a.count === 1 ? '' : 's'}${a.unread ? ' · new reply' : ''}`
function questionsNode(lj: LoadedJourney): Node | undefined {
  const qs = notes().filter((n) => matchesFilter(n) && journeyOfNote(n) === lj)
  return qs.length ? cached(`questions:${lj.key}`, { kind: 'questions' as const, lj, notes: qs }) : undefined
}

function journeyItem(lj: LoadedJourney): vscode.TreeItem {
  // The short title is the row; the question is the tooltip (R1). The description is state only: where it was
  // left (3/14; while walking the icon says so and the card and status bar have the position), new, stale.
  const q = questionsNode(lj)
  // The title isolated: right-to-left text in it never pulls the description into the label.
  const item = new vscode.TreeItem(isolate(lj.j.title), q ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
  item.id = `journey:${lj.key}`
  const active = lj.key === tourKey && tourStep > 0
  // A reply to a step question shows on the folded row, like an unread note.
  const qs = q && q.kind === 'questions' ? q.notes : []
  const newReplies = qs.filter((n) => unread(n) > 0).length
  // State only: no step count, no position, no question count (the questions are the rows below);
  // stale steps are the icon.
  // Where it was left, quietly (as in the panel's list); none while walking (the icon says it) or never opened.
  const left = !active ? resumeAt(lj) : 0
  item.description = [left ? `${left}/${lj.j.steps.length}` : '', newReplies ? `${newReplies} repl${newReplies === 1 ? 'y' : 'ies'}` : '', lj.readError ? '⚠ unreadable' : '', isNewJourney(lj) ? 'new' : ''].filter(Boolean).join(' · ') || undefined

  // The icon says state only: walking, or stale steps; a plain row otherwise.
  // No stale ⚠ here: the step card says it, the storyline marks the step.
  item.iconPath = active ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('codeNotes.noteRuler')) : newReplies ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codeNotes.unreadForeground')) : undefined
  // The question only; the accessible name is what is seen.
  // "new" is only a new journey: an unread answer is "1 reply", said in full here.
  item.tooltip = newReplies ? `${lj.j.question}\n${newReplies} unread repl${newReplies === 1 ? 'y' : 'ies'} from Claude` : lj.j.question
  // the name read is the title and its state; the question is only the tooltip.
  item.accessibilityInformation = { label: [lj.j.title, active ? `walking, step ${tourStep} of ${lj.j.steps.length}` : left ? `left at step ${left} of ${lj.j.steps.length}` : '', newReplies ? `${newReplies} unread repl${newReplies === 1 ? 'y' : 'ies'}` : '', isNewJourney(lj) ? 'new' : ''].filter(Boolean).join(', ') }
  item.contextValue = 'journey'
  item.command = { command: 'codeNotes.openJourney', title: 'Walk Journey', arguments: [lj.key] }
  return item
}

function revealJourneyRow(lj: LoadedJourney): void {
  if (!treeView.visible) return
  treeView.reveal(journeyNode(lj), { select: true, focus: false, expand: false }).then(undefined, () => { /* not listed */ })
}

function updateTour(): void {
  const lj = tourJourney()
  if (tourKey && !lj) {
    // The journey file was deleted: the tour ends with one notice; the map says so.
    if (tourStep) vscode.window.setStatusBarMessage('$(info) The journey was deleted; it ended', 5000)
    mapPanel.markDeleted(tourKey)
    tourKey = undefined; tourStep = 0; tourDoc = undefined; clearCard(); void state.update(TOUR_KEY, undefined)
  }
  if (lj && tourStep > lj.j.steps.length) tourStep = lj.j.steps.length
  // A step question's back-link says less while you walk its journey.
  if (store) for (const n of notes()) if (stepLinkOf(n)) syncThread(n)
  setCtx('codeNotes.journeyActive', touring())
  lensChanged.fire() // the step lenses show only outside a walk
  setCtx('codeNotes.hasJourneys', journeys.list.size > 0)
  mapPanel.update()
  if (!lj || !tourStep) { for (const i of Object.values(tourItems)) i.hide(); return }
  // Only while a tour runs, and one item: "3/13", click = the map; ‹ › × live on the map and the card.
  const total = lj.j.steps.length
  // "3/14": the journey's name is the map tab's title; a one-line tooltip.
  tourItems.pos.text = `$(map) ${tourStep}/${total}`
  tourItems.pos.accessibilityInformation = { label: `${lj.j.title}, step ${tourStep} of ${total}. Opens the map.` }
  tourItems.pos.tooltip = `${lj.j.title}: open the map`
  tourItems.pos.show()
  tourItems.prev.hide(); tourItems.next.hide(); tourItems.end.hide()
}

/** The code group: never the map's. The one the tour used, else another visible editor's, else the other side. */
function codeColumn(): vscode.ViewColumn | undefined {
  const mapCol = mapPanel.viewColumn
  if (mapCol === undefined) return tourDoc?.column ?? vscode.window.activeTextEditor?.viewColumn
  if (tourDoc && tourDoc.column !== mapCol && vscode.window.tabGroups.all.some((g) => g.viewColumn === tourDoc!.column)) return tourDoc.column
  return vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== mapCol)?.viewColumn
    ?? (mapCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One)
}

/**
 * Where to show a file: the editor that already shows it (outside the map's group), else the code group. A second
 * editor on the same file makes VS Code build a second comment widget for a thread made just after (the step card,
 * a new note) before the thread's first state arrives, and those widgets loop on its collapsed state ("Maximum call
 * stack size exceeded"; the card or thread then stays collapsed). See SETTLE_MS.
 */
function columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const mapCol = mapPanel.viewColumn
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString() && e.viewColumn !== undefined && e.viewColumn !== mapCol)?.viewColumn ?? codeColumn()
}

function showMap(lj: LoadedJourney, preserveFocus = false): void {
  mapPanel.show(lj, preserveFocus, tourDoc?.column)
  void state.update(MAP_KEY, posKey(lj))
}

/** goToStep calls still running (a scene going away meanwhile leaves the editor to them:). */
let stepping = 0
/** Opens step n: the code in the code group as a preview tab (one tab, reused:), the step card above its lines. */
async function goToStep(lj: LoadedJourney, n: number, opts: { focus?: boolean } = {}): Promise<void> {
  stepping++
  try { await openStep(lj, n, opts) } finally { stepping-- }
}
async function openStep(lj: LoadedJourney, n: number, opts: { focus?: boolean }): Promise<void> {
  if (!lj.j.steps.length) return
  n = Math.max(1, Math.min(n, lj.j.steps.length))
  // Another step: the last one's beat is no longer lit (its scene sends the new step's beats).
  if (tourStep !== n || tourKey !== lj.key) beats.clear()
  if (tourKey && tourKey !== lj.key && tourStep) await leaveJourney() // one journey at a time, ended cleanly
  if (tourStep === 0 || tourKey !== lj.key) stepDetailsOpen = false
  if (tourStep !== n) stepDetailsOpen = false
  tourKey = lj.key
  tourStep = n
  finishedKey = undefined
  tourId = lj.j.steps[n - 1].id
  // The map shows the journey being walked: another journey's map (a look) gives way when a step moves.
  if (mapPanel.journey && mapPanel.journey.key !== lj.key) showMap(lj, true)
  await state.update(TOUR_KEY, posKey(lj))
  await savePos(lj, n)
  await journeys.locate(lj, (k) => k === n)
  updateTour()
  tree.refresh()
  const file = fileOf(lj, n)
  const uri = vscode.Uri.joinPath(lj.folder.uri, file)
  await checkRefs(lj, n)
  // A file that is gone: no stand-in tab; the card, in the map, says so.
  stepFileGone = false
  try { await vscode.workspace.fs.stat(uri) } catch { stepFileGone = true }
  // Its code was deleted: no code under the card pretending to be it; the card shows what it was.
  if (cardNotice && cardNotice.id !== tourId) cardNotice = undefined
  shownAt = { key: lj.key, id: tourId, file, start: lj.at[n - 1].start, end: lj.at[n - 1].end, removed: !!lj.at[n - 1].removed, wrote: wroteAt(lj, n) }
  if (stepFileGone || lj.at[n - 1].removed) {
    refHere = undefined
    showCard(lj, n)
    showMap(lj, true)
    revealJourneyRow(lj)
    return
  }
  const column = columnFor(uri)
  const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: opts.focus === false, ...(column ? { viewColumn: column } : {}) })
  if (editor.viewColumn) tourDoc = { uri, column: editor.viewColumn }
  // Steps right after opening the file: anchoring against the open document (unsaved edits count).
  await journeys.locate(lj, (k) => k === n)
  const at = lj.at[n - 1]
  shownAt = { key: lj.key, id: tourId!, file, start: at.start, end: at.end, removed: !!at.removed, wrote: wroteAt(lj, n) }
  refHere = undefined
  // The editor just opened on this file: the card is made once it has settled (see editorSettling).
  const settle = editorSettling(uri)
  if (settle) { await new Promise((r) => setTimeout(r, settle)); if (tourKey !== lj.key || tourStep !== n) return }
  showCard(lj, n)
  // The card lives in the map ("panel"): the map is open beside the code.
  if (cardInMap(lj, n) && mapPanel.journey?.key !== lj.key) showMap(lj, true)
  const first = Math.max(0, at.removed ? 0 : at.start - 1)
  tourCursorUntil = Date.now() + 600
  editor.selection = new vscode.Selection(first, 0, first, 0)
  // A note on the step's lines folds, so the step comes first; it stays unread.
  for (const nt of notesFor(uri)) if (nt.data.range.start <= at.end && nt.data.range.end >= at.start) { const th = threads.get(nt.data.id); if (th) setCollapse(th, vscode.CommentThreadCollapsibleState.Collapsed, nt.data.id) }
  // The card (or the marker line) sits above the step's lines: bring it to the top, so card and code are both on
  // screen. Again once the card is drawn: a jump from the map otherwise left the card above the view.
  // While the step's animation lights a beat, the beat's line is what is on screen: brought back once,
  // in case this step's file was shown over it.
  let beatBack = false
  const top = () => {
    if (beats.lit) { if (!beatBack && tourStep === n && tourKey === lj.key) { beatBack = true; void beats.again(codeColumn) } return }
    if (tourStep === n && tourKey === lj.key) { const l = Math.max(0, Math.min(cardLine(lj, n), lj.at[n - 1].start - 1) - 1); editor.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.AtTop) } }
  top()
  setTimeout(top, 120)
  setTimeout(top, 400)
  refreshDecorations()
  revealJourneyRow(lj)
}

/**
 * A journey left for another one mid-way: it ends cleanly (card, status item, marker go:), its place kept
 * for Resume; no toast.
 */
let lastLeft: { title: string; at: string } | undefined
async function leaveJourney(): Promise<void> {
  const lj = tourJourney()
  const n = tourStep
  await endTour()
  if (lj && n) lastLeft = { title: lj.j.title, at: `${n}/${lj.j.steps.length}` }
}

/** Files referenced by the current step that don't exist (folder|path), and how many lines the others have, checked when the step opens. */
const refGone = new Set<string>()
const refLines = new Map<string, number>()
async function checkRefs(lj: LoadedJourney, n: number): Promise<void> {
  const s = lj.j.steps[n - 1]
  const moved = journeys.renames(lj)
  const files = new Set<string>()
  for (const r of s.refs) if (!/\s/.test(r.trim())) files.add(r.replace(/(:\d+)?([-–]\d+)?$/, ''))
  for (const r of s.refs) for (const m of r.matchAll(/((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?::\d+|#L\d+)/g)) files.add(m[1])
  for (const t of [s.lead, s.details ?? '']) for (const m of t.matchAll(/((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?::\d+|#L\d+)/g)) files.add(m[1])
  for (const f0 of files) {
    const f = moved.get(f0) ?? f0
    const k = `${lj.folder.uri}|${f}`
    const ls = await linesOfUri(vscode.Uri.joinPath(lj.folder.uri, f))
    if (ls) { refGone.delete(k); refLines.set(k, ls.length) } else { refGone.add(k); refLines.delete(k) }
  }
}

/** A read-only copy of a file (its text now, unsaved edits included), peeked for a ref into the step's own file. */
const REF_SCHEME = 'code-notes-ref'
// A fresh copy per peek (the fragment): VS Code keeps a virtual document's text once read.
const refCopyUri = (uri: vscode.Uri) => uri.with({ scheme: REF_SCHEME, query: uri.scheme, fragment: String(Date.now()) })
async function refCopy(uri: vscode.Uri): Promise<string> {
  const real = uri.with({ scheme: uri.query || 'file', query: '', fragment: '' })
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === real.toString())
  if (open) return open.getText()
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(real)) } catch { return '' }
}
/** The page shown for a step whose file doesn't exist. */
const STEP_SCHEME = 'code-notes-step'
const stepPage = (file: string) => `⚠ ${file} doesn't exist any more (moved or deleted). The step is below; its code can't be shown.\n`
/** Where the step's card goes: its file, or the page saying the file is gone. */
function stepUri(lj: LoadedJourney, n: number): vscode.Uri {
  const f = fileOf(lj, n)
  return vscode.Uri.joinPath(lj.folder.uri, f)
}

/**
 * The 0-based line the inline card hangs under (VS Code draws a thread under its line): the line right before the
 * step's first line, always (you read the card, then the code; above a doc comment it left the code at the
 * bottom edge). A step on line 1 has its card under that line.
 */
function cardLine(lj: LoadedJourney, n: number): number {
  const at = lj.at[n - 1]
  if (at.removed) return 0
  return Math.max(0, at.start - 2)
}
/** The step's file doesn't exist: its card is in the map, whatever the setting. */
let stepFileGone = false
/**
 * One step card, inline above the code (no panel mode). Only a step with no code to sit on (its
 * file is gone,, or its code was deleted:, never pinned on unrelated code such as line 1) shows its card in
 * the map instead.
 */
const cardInMap = (lj: LoadedJourney, n: number) => lj.key === tourKey && tourStep === n && (stepFileGone || !!lj.at[n - 1]?.removed)
/** One line on the card about what just changed under the reader: for that step only. */
let cardNotice: { id: string; text: string } | undefined
/** Where the current step was shown (to see that the agent moved it:). */
/** `wrote`: where the journey file put the step then (a change there is the agent re-anchoring it:). */
let shownAt: { key: string; id: string; file: string; start: number; end: number; removed: boolean; wrote: string } | undefined
const wroteAt = (lj: LoadedJourney, n: number) => { const s = lj.j.steps[n - 1]; return `${s.file}:${s.range.start}-${s.range.end}` }

/** A link in a step's text: where it goes now (renames, moved lines), and how it reads. */
interface StepRef { label: string; file: string; line: number; end: number; gone: boolean; stale: boolean }
/**
 * A step's text, the same for the inline card and the panel: `link` makes each reference a link (a command URI
 * inline, `ref:i` in the panel).
 */
/** What a stale step's card says first: gone, removed, or what changed, and one thing to do. */
function staleText(lj: LoadedJourney, n: number, ask: string): string {
  // One line: what is known, and the one thing to do. The git gutter shows what changed.
  const at = lj.at[n - 1]
  // Never "gone" for code that was only edited or moved (it read as "the feature was removed").
  if (stepFileGone && tourStep === n) return `**⚠ File moved or deleted** · ${ask}`
  if (!at.stale) return ''
  return `**⚠ ${at.removed || at.was === undefined ? 'Code changed: can\'t find these lines' : 'Code changed'}** · ${ask}`
}

function stepText(lj: LoadedJourney, n: number, link: (r: StepRef) => string): { lead: string; details: string; refs: string; stale: boolean } {
  const s = lj.j.steps[n - 1]
  const at = lj.at[n - 1]
  const moved = journeys.renames(lj)
  // Lines in the step's own file move with it. A stale step's refs are judged on their own: its lost
  // lines move nothing, and only a ref whose file or line is gone is marked.
  const delta = at.stale ? 0 : at.start - s.range.start
  const make = (text: string, file0: string, line: number, end?: number) => {
    // A renamed file: the link follows it and says so; a file that is gone: struck out, not a dead link.
    const file = moved.get(file0) ?? file0
    const same = file === fileOf(lj, n)
    const shown = same ? Math.max(1, line + delta) : line
    let label = same && delta ? text.replace(/:(\d+)(?:([-–])(\d+))?$/, (_m, a: string, d?: string, b?: string) => `:${Math.max(1, +a + delta)}${d ? `${d}${Math.max(1, +b! + delta)}` : ''}`) : text
    if (file !== file0) label = `${label.replace(file0, file).replace(file0.split('/').pop()!, file.split('/').pop()!)} (moved)`
    // A reference reads as `env.go:405`: the file's name; the whole path is the link's hover.
    label = label.replace(/(?:[\w.-]+\/)+([\w.-]+\.[a-zA-Z]{1,6})/g, '$1')
    const k = `${lj.folder.uri}|${file}`
    if (refGone.has(k) || (refLines.get(k) ?? Infinity) < shown) return `~~${text.replace(/[[\]]/g, '').replace(/(?:[\w.-]+\/)+([\w.-]+\.[a-zA-Z]{1,6})/g, '$1')}~~ (${refGone.has(k) ? 'file' : 'line'} gone)`
    // One stale marker per step, the card's banner: no ⚠ on its links.
    return link({ label, file, line: shown, end: Math.max(shown, (end ?? line) + (same ? delta : 0)), gone: false, stale: false })
  }
  const rangeEnd = (t: string) => { const m = /[-–](\d+)`?$/.exec(t); return m ? Number(m[1]) : undefined }
  const paths = (t: string) => linkPaths(t, (text, file, line) => make(text, file, line, rangeEnd(text)))
  // No "(path:line)" asides in More: those places are the references, listed once under it.
  const details = (s.details ?? '').replace(/\s*\(`?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,6}(?::\d+(?:[-–]\d+)?|#L\d+)`?\)/g, '')
  // Each file named once: no ref to the lines already on screen, none the open details already link.
  const inDetails = new Set<string>()
  if (stepDetailsOpen && details) linkPaths(details, (_t, file, line) => { inDetails.add(`${file}:${line}`); return '' })
  // A ref inside a code link's lines repeats that link: the phrase on the card already goes there.
  const text = `${s.lead ?? ''}\n${s.details ?? ''}`
  const linked = readLinks(s.links).filter((l) => text.includes(l.phrase)).map((l) => ({ ...l, file: moved.get(l.file) ?? l.file }))
  const inLink = (file: string, line: number) => !!line && linked.some((l) => l.file === (moved.get(file) ?? file) && line >= l.start && line <= l.end)
  const onScreen = (file: string, line: number) => (line && inDetails.has(`${file}:${line}`)) || inLink(file, line) || (line && (moved.get(file) ?? file) === fileOf(lj, n) && !at.stale && line + delta >= at.start && line + delta <= at.end)
  // A ref is a bare `path:line` (listed with ' · '), or an explained sentence holding one such token:
  // the sentence as written, its token a link reading `main.go:371` (the whole path on hover).
  const isSentence = (r: string) => /\s/.test(r.trim())
  const plainRefs = s.refs.filter((r) => !isSentence(r)).map((r) => /^(.*?)(?::(\d+))?(?:[-–](\d+))?$/.exec(r)!).filter((m) => !onScreen(m[1], Number(m[2]) || 0))
    .map((m) => make(`${m[1].split('/').pop()}${m[2] ? `:${m[2]}` : ''}`, m[1], Number(m[2]) || 1, m[3] ? Number(m[3]) : undefined)).join(' · ')
  const sentences = s.refs.filter(isSentence).filter((r) => { let keep = true; linkPaths(r, (_t, file, line) => { if (onScreen(file, line)) keep = false; return '' }); return keep })
    .map((r) => paths(r.trim()))
  const refs = [plainRefs, ...sentences].filter(Boolean).join('\n\n')
  // No recap on the last step: the map's header has the question.
  return { lead: s.lead ? paths(s.lead) : '', details: details ? paths(details) : '', refs, stale: at.stale }
}

const UPDATE_ASK = 'This step is out of date: its code changed or was deleted. Please update the step.'
/** The panel's step card, and the links it shows (posted back by index). */
let panelRefs: StepRef[] = []
function panelCard(lj: LoadedJourney, n: number): object {
  const refs: StepRef[] = []
  const t = stepText(lj, n, (r) => { refs.push(r); return `[${r.label.replace(/[[\]]/g, '').replace(/^.*\//, '')}](ref:${refs.length - 1})` })
  panelRefs = refs
  const paths = refs.map((r) => `${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}`)
  const a = askedOf(lj)[n]
  return { n, lead: t.lead, ...(t.details ? { details: t.details } : {}), refs: t.refs, stale: t.stale || (stepFileGone && tourStep === n),
    staleText: staleText(lj, n, a?.update ? `[Asked ›](note:${a.id})` : '[Ask](ask:update)'), open: stepDetailsOpen,
    ...(cardNotice && cardNotice.id === lj.j.steps[n - 1].id ? { notice: cardNotice.text } : {}), title: lj.j.steps[n - 1].title, paths }
}

function stepMarkdown(lj: LoadedJourney, n: number): vscode.MarkdownString {
  const total = lj.j.steps.length
  // The link's hover is the whole path; a stale one says its line may be off.
  const t = stepText(lj, n, (r) => `[${r.label}](command:codeNotes.openAt?${encodeURIComponent(JSON.stringify([lj.folder.uri.toString(), r.file, r.line, r.end, n]))} "${r.file}:${r.line}${r.end > r.line ? `-${r.end}` : ''}${r.stale ? ' (the code changed: this line may be off)' : ''}")`)
  const parts: string[] = []
  // Its code can't be found: say what happened first, and the one thing to do; nothing else is highlighted.
  const asked = askedOf(lj)[n]
  // One action: ask (the note box opens prefilled:); once asked, the way to that note.
  const st = staleText(lj, n, asked?.update ? cmdLink('Asked ›', 'codeNotes.openNoteId', asked.id) : cmdLink('Ask', 'codeNotes.askStepUpdate'))
  // A slim band: under the header line "3/14 · title", one row ‹ › Ask (More), then the lead; More grows the
  // card below, so ‹ › never move. The step's questions are one of the actions; More holds
  // the details and the references.
  const nav = [
    // Words beside the glyphs: a bare ‹ › is too small a target.
    n > 1 ? cmdLink('‹ Previous', 'codeNotes.previousStep') : '',
    n < total ? cmdLink('Next ›', 'codeNotes.nextStep') : cmdLink('Finish', 'codeNotes.nextStep'),
    asked ? cmdLink(`${askedText(asked)} ›`, 'codeNotes.openNoteId', asked.id) : '',
    // One Ask: a stale step's is the banner's, which opens the request prefilled.
    st ? '' : cmdLink('Ask', 'codeNotes.askStep'),
    t.details || t.refs ? (stepDetailsOpen ? cmdLink('Less', 'codeNotes.stepDetails', false) : cmdLink('More', 'codeNotes.stepDetails', true)) : '',
  ].filter(Boolean)
  // Real no-break spaces, not &nbsp;: VS Code reads the card's Markdown source aloud.
  // the warning (a stale step), the lead, then the buttons; More grows below them; a notice last, quiet.
  if (st) parts.push(st)
  // Code links: a phrase that is a link to the lines doing what it says: the text's own colour on a
  // faint tint (theme colours, so every theme; never a reference's blue), the tint its lines carry in the code. Placeholders here; the markup goes in after escapeTags.
  const links = readLinks(lj.j.steps[n - 1].links)
  const linkKey = `${lj.key}|${lj.j.steps[n - 1].id}`
  const usedLinks = new Set<number>()
  const mark = (x: string) => linkPhrases(x, links, usedLinks, (i, phrase) => `\u27E6${i}\u27E7${phrase}\u27E6/\u27E7`)
  if (t.lead) parts.push(mark(t.lead))
  parts.push(nav.join(' \u00a0 '))
  if (stepDetailsOpen && t.details) parts.push(mark(t.details))
  // Only the phrases on the card now have their lines marked: those behind "More" while it is open.
  // Value hints: what the step's variables hold in the example run, faint, above their lines.
  valueHints.present(linkKey, lj.folder.uri, readValues(lj.j.steps[n - 1].values), journeys.renames(lj))
  if (links.length) codeLinks.present(linkKey, lj.folder.uri, links, journeys.renames(lj), [...usedLinks]); else codeLinks.clear()
  if (stepDetailsOpen && t.refs) parts.push(t.refs)
  // What just changed under the reader, once, on this step.
  if (cardNotice && cardNotice.id === lj.j.steps[n - 1].id) parts.push(`_ℹ ${cardNotice.text}_`)
  // `<name>` in the text is text: VS Code's renderer would drop it as an HTML tag.
  const body = escapeTags(parts.join('\n\n')).replace(/\u27E6(\d+)\u27E7([\s\S]*?)\u27E6\/\u27E7/g, (_m, i: string, phrase: string) => {
    const l = links[Number(i)]
    const tip = `${l.file.split('/').pop()}:${l.start}${l.end > l.start ? `-${l.end}` : ''} · show the code that does this`
    // VS Code styles every span in a comment `white-space: pre`, so one span around the phrase can't wrap: a span
    // per word (its space inside, so the tint has no gaps) and a zero-width space between them to break at.
    const words = String(phrase).split(/ +/).filter(Boolean)
    const tinted = words.map((w, k) => `<span style="color:var(--vscode-foreground);background-color:${tutorialMark === 'links' ? TUTORIAL_HI : 'var(--vscode-toolbar-hoverBackground)'};">${w}${k < words.length - 1 ? ' ' : ''}</span>`).join('\u200b')
    return `[${tinted}](command:codeNotes.codeLink?${encodeURIComponent(JSON.stringify([linkKey, Number(i)]))} "${tip}")`
  })
  // The tutorial's card about this card: its buttons stand out while that card is up.
  const shown = tutorialMark !== 'card' ? body : body.replace(/\[([^\]]+)\]\(command:codeNotes\.(nextStep|previousStep|askStep|stepDetails)/g, (_m, label: string, c: string) => `[<span style="color:var(--vscode-foreground);background-color:${TUTORIAL_HI};">${label}</span>](command:codeNotes.${c}`)
  const md = new vscode.MarkdownString(shown)
  md.isTrusted = { enabledCommands: ['codeNotes.codeLink', 'codeNotes.openAt', 'codeNotes.nextStep', 'codeNotes.previousStep', 'codeNotes.endJourney', 'codeNotes.askStep', 'codeNotes.askStepUpdate', 'codeNotes.openNoteId', 'codeNotes.stepDetails'] }
  // Only for the code links' colour; every other tag in the text was escaped above.
  md.supportHtml = links.length > 0 || tutorialMark === 'card'
  md.baseUri = lj.folder.uri
  return md
}

/**
 * The step card: a comment thread of its own controller ("Journey"), so none of the note menus apply: no reply box,
 * no author picture, no time, no resolve/delete. Its header is "3/14 · <title>"; the body has no author line.
 */
function showCard(lj: LoadedJourney, n: number): void {
  lensChanged.fire()
  if (cardInMap(lj, n)) { stepThread?.dispose(); stepThread = undefined; mapPanel.update(); return }
  const s = lj.j.steps[n - 1]
  const uri = stepUri(lj, n)
  const cl = cardLine(lj, n)
  const range = new vscode.Range(cl, 0, cl, 0)
  // A new thread per step (moving one left the card drawn above the view:).
  // VS Code HTML-escapes a thread's label and then shows it as text ("&lt;script&gt;"): <, > and & are drawn
  // with look-alikes instead.
  const label = `${n}/${lj.j.steps.length} · ${s.title.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆')}`
  const fresh = !stepThread || stepThread.uri.toString() !== uri.toString() || stepThread.label !== label || stepThread.range?.start.line !== range.start.line
  if (fresh) {
    // Its editor is just opening (see editorSettling): the card comes a moment later.
    const wait = editorSettling(uri)
    if (wait) {
      clearTimeout(settleLater.get('card'))
      settleLater.set('card', setTimeout(() => { settleLater.delete('card'); if (touring() && tourJourney() === lj && tourStep === n) showCard(lj, n) }, wait))
      return
    }
    stepThread?.dispose()
    stepThread = newThread(stepController, uri, range)
  } else if (settling(stepThread!)) {
    // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
    whenSettled(stepThread!, 'card', () => { if (touring() && tourJourney() === lj && tourStep === n) showCard(lj, n) })
    return
  }
  const t = stepThread!
  setThread(t, 'canReply', false)
  setThread(t, 'contextValue', 'step')
  // The card's first line is "3/14 · <title>": the position once, and the title, since the map may not be
  // in view from the code. A stale step says so in its text.
  setThread(t, 'label', label)
  const body = stepMarkdown(lj, n)
  if (fresh || (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value !== body.value)
    t.comments = [{ body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }]
  setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
}

/**
 * The step's card and marker belong to the step's lines, not to a tab: whenever its file is on screen again (Go Back,
 * "Back to step", a tab switch, the file reopened) they are there. A preview tab that was replaced
 * closed the document, and VS Code drops a thread's widget with it: the thread is made again.
 */
let restoring = false
/** The step file that was on screen at the last change (only a return re-makes the card). */
let stepShownFor: string | undefined
function restoreStepCard(): void {
  const lj = touring() ? tourJourney() : undefined
  if (!lj || cardInMap(lj, tourStep) || restoring) return
  const uri = stepUri(lj, tourStep).toString()
  const shown = vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri)
  const back = shown && stepShownFor !== uri
  stepShownFor = shown ? uri : undefined
  if (!back) return
  // Back on the step's file: the ref is left behind.
  if (refHere && refHere.uri !== uri && !vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === refHere!.uri)) { refHere = undefined; lensChanged.fire() }
  restoring = true
  try { stepThread?.dispose(); stepThread = undefined; showCard(lj, tourStep) } finally { restoring = false }
}

function clearCard(): void {
  stepThread?.dispose()
  stepThread = undefined
  refHere = undefined
  lensChanged.fire()
  for (const e of vscode.window.visibleTextEditors) if (refDeco) e.setDecorations(refDeco, [])
  for (const t of stepAsks.keys()) t.dispose()
  stepAsks.clear()
  if (stepDeco) for (const e of vscode.window.visibleTextEditors) { e.setDecorations(stepDeco.at, []); e.setDecorations(stepDeco.stale, []) }
}

/** The running step's lines: a quiet bar (amber when stale). */
/** Editors (their file) that show the step's bar now (for the tests). */
let stepMarked: string[] = []
function refreshStepDecorations(): void {
  const lj = touring() ? tourJourney() : undefined
  const s = lj?.j.steps[tourStep - 1]
  stepMarked = []
  for (const e of vscode.window.visibleTextEditors) {
    const here = lj && s && e.document.uri.toString() === vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tourStep)).toString()
    const at = here ? lj!.at[tourStep - 1] : undefined
    // A stale step highlights nothing: what is there now is other code; the card says so.
    e.setDecorations(stepDeco.at, at && !at.stale ? [new vscode.Range(at.start - 1, 0, at.end - 1, 0)] : [])
    if (at && !at.stale) stepMarked.push(e.document.uri.path)
    e.setDecorations(stepDeco.stale, [])
    if (refDeco) e.setDecorations(refDeco, refHere && lj && refHere.uri === e.document.uri.toString() ? [new vscode.Range(refHere.start, 0, refHere.end, 0)] : [])
  }
}

async function stepBy(dir: 1 | -1): Promise<void> {
  if (touring()) {
    const lj = tourJourney()!
    const n = tourStep + dir
    if (n > lj.j.steps.length) return finishTour()
    if (n < 1) { vscode.window.setStatusBarMessage('$(info) First step', 2000); return }
    return goToStep(lj, n)
  }
  // No tour: start (or resume) the journey whose map is open, else pick one.
  const lj = tourJourney() ?? (await pickJourney())
  // Just finished: next is not step 1 again; the panel says Done.
  if (lj && finishedKey === lj.key) { vscode.window.setStatusBarMessage('$(check) Journey finished', 2500); showMap(lj); return }
  if (lj) await goToStep(lj, resumeAt(lj) || 1)
}

/** "Fable" from "claude-fable-5-2"; '' when the model is unknown. */
function modelName(model?: string): string {
  const m = /^(?:claude-)?([a-z]+)/i.exec(model ?? '')
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : ''
}
/** "11 Nov" (this year), "11 Nov 2025" (another year), from the journey's own date. */
function shortDate(at?: string): string {
  const t = Date.parse(at ?? '')
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}
/**
 * The map's one provenance line: who wrote it and when, from the journey's own `model` and `createdAt` (not
 * the file's date: a fresh clone is not "today"). No "n commits behind": staleness shows per step (changed / gone).
 */
function provenance(lj: LoadedJourney): { text: string; tip: string; changed: number } {
  const who = modelName(lj.j.model), when = shortDate(lj.j.createdAt)
  const text = who ? `Written by ${who}${when ? ` · ${when}` : ''}` : when ? `Written ${when}` : ''
  const tip = [lj.j.model, lj.j.commit ? `commit ${lj.j.commit.slice(0, 10)}` : ''].filter(Boolean).join(' · ')
  return { text, tip, changed: staleCount(lj) }
}

/** Steps whose code can't be found now (the picker says so). */
const staleCount = (lj: LoadedJourney) => lj.at.filter((a) => a.stale).length

async function pickJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const all = journeyOrder()
  if (typeof arg === 'string') return all.find((x) => x.key === arg || x.j.id === arg || posKey(x) === arg)
  if (arg && typeof arg === 'object' && (arg as Node).kind === 'journey') return (arg as { lj: LoadedJourney }).lj
  // Always a picker (the "…" promises one): the question once, and how far each one got.
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
  // Words, not scattered letters: each word must be in the title, question, summary or a step's title; the
  // best matches first, with the step that matched.
  const hay = (x: LoadedJourney) => [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()
  const item = (x: LoadedJourney, words: string[]) => {
    const step = words.length ? x.j.steps.find((st) => words.some((w) => st.title.toLowerCase().includes(w))) : undefined
    // One line per journey: the short title; the step that matched (when only a step did), else the question
    // when it says more than the title; a ⚠ when its file can't be read; the folder when there are several.
    const q = x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question
    return {
      ask: undefined as string | undefined,
      label: `${x.key === tourKey && tourStep ? '$(play-circle) ' : ''}${x.j.title}`,
      description: [step && !words.every((w) => hay(x).includes(w)) ? `step ${step.n}: ${step.title}` : q, x.readError ? '⚠' : '', multi ? x.folder.name : ''].filter(Boolean).join(' · '),
      alwaysShow: true, // filtered here, not by VS Code
      lj: x as LoadedJourney | undefined,
    }
  }
  const qp = vscode.window.createQuickPick<ReturnType<typeof item>>()
  // No title; in progress first, then the best match, the exact title first.
  qp.placeholder = all.length ? 'Open a journey' : 'Type a question about the code'
  qp.matchOnDescription = false
  qp.matchOnDetail = false
  const update = () => {
    const words = qp.value.toLowerCase().split(/\s+/).filter(Boolean)
    const typed = qp.value.trim().toLowerCase()
    const score = (x: LoadedJourney) => journeyScore(x, words, typed)
    const going = (x: LoadedJourney) => (x.key === tourKey && tourStep ? 2 : resumeAt(x) ? 1 : 0)
    const items = all.map((x) => ({ x, k: score(x) })).filter((v) => v.k >= 0).sort((a, b) => b.k - a.k || going(b.x) - going(a.x)).map((v) => item(v.x, words))
    // Nothing matches: one item that asks the agent to write that journey.
    const q = qp.value.trim()
    qp.items = items.length || !q ? items : [{ ask: q, label: `$(sparkle) Write a journey for '${q}' with Claude`, description: `${modelLabel(journeyModel())}, about 3 min`, alwaysShow: true, lj: undefined }]
  }
  qp.onDidChangeValue(update)
  update()
  const pick = await new Promise<ReturnType<typeof item> | undefined>((res) => {
    qp.onDidAccept(() => { const p = qp.selectedItems[0]; res(p); qp.hide() })
    qp.onDidHide(() => { res(undefined); qp.dispose() })
    qp.show()
  })
  if (pick?.ask) { void writeJourney(pick.ask); return undefined }
  return pick?.lj
}

/** Journeys Claude is writing now: never listed half-made; one row each, "Writing: <question> · 1:20". */
interface Writing { id: string; question: string; started: number; phase: string; model: string; ask?: Ask }
const writingNow = new Map<string, Writing>()
/** Fires when a journey starts or stops being written, and every second while one is (for a list's row). */
const writingChanged = new vscode.EventEmitter<void>()
/** The rows a list can show for the journeys being written (`id` for cancelWriting). */
function writingRows(): { id: string; label: string; question: string; phase: string; model: string }[] {
  return [...writingNow.values()].map((w) => ({ id: w.id, question: w.question, phase: w.phase, model: w.model, label: `Writing: ${w.question} · ${clock(Date.now() - w.started)}` }))
}
function cancelWriting(id: string): void { writingNow.get(id)?.ask?.cancel() }

/** The model a journey is written with (a request's `model`, the settings), and how it is named. */
const journeyModel = (override?: string) => override || cfg().get<string>('journeys.model') || cfg().get<string>('claude.model') || undefined
const modelLabel = (m?: string) => m || 'Claude Code default'
const shortQ = (q: string, max = 60) => { const t = q.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/**
 * The code-journey skill: the repository's own copy (a team can pin and adapt it), else the home folder's, else the one
 * that ships with the extension (so writing a journey works with nothing installed).
 */
function journeySkill(folder: vscode.WorkspaceFolder): string | undefined {
  const home = require('os').homedir() as string
  const fs = require('fs') as typeof import('fs')
  return [`${folder.uri.fsPath}/.claude/skills/code-journey`, `${home}/.claude/skills/code-journey`, bundledSkill()].find((d) => fs.existsSync(`${d}/scripts`))
}
/** The copy inside the extension: Claude Code does not know it as a skill, so the prompt names its SKILL.md instead. */
const bundledSkill = () => `${extUri.fsPath}/skills/code-journey`

/** journey.py with a staging folder; never throws. */
function journeyPy(skill: string, repo: string, stage: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('python3', [`${skill}/scripts/journey.py`, '--dir', stage, ...args], { cwd: repo, timeout: 120_000, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${out ?? ''}${errOut ?? ''}`.trim() })
    })
  })
}

interface WriteOptions { model?: string; resume?: { session: string; reply: string } }

/**
 * a journey for a question nobody wrote one for. With the `claude` CLI: Claude Code headless with the
 * code-journey skill (read-only tools, Bash only for the skill's own scripts), only in a trusted folder.
 * It writes into a staging folder; the journey moves into the journeys folder once `journey.py check` passes,
 * stamped with the model, and is announced. Claude may answer with a question instead: shown with a
 * reply box that goes on in the same session. Without the CLI: a ready prompt on the clipboard.
 */
async function writeJourney(question: string, o: WriteOptions = {}): Promise<LoadedJourney | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  if (!claudeAllowed('write journeys')) return undefined
  const cli = findCli(cfg().get<string>('claude.path') || undefined)
  if (!cli) {
    const prompt = `Use the code-journey skill to answer: ${question}`
    await vscode.env.clipboard.writeText(prompt)
    void vscode.window.showInformationMessage(`Copied a prompt for your agent: "${prompt}"`)
    return undefined
  }
  const home = require('os').homedir() as string
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const repo = folder.uri.fsPath
  const cache = `${process.env.XDG_CACHE_HOME ?? `${home}/.cache`}/code-journey`
  const skill = journeySkill(folder)
  if (!skill) {
    void showError('Code Notes: the code-journey skill isn\'t in this repository (.claude/skills/code-journey) or in ~/.claude/skills, so Claude can\'t write a journey here.')
    return undefined
  }
  const model = journeyModel(o.model)
  const bad = modelProblem(model)
  if (bad) { void showError(`Code Notes: ${bad}`); return undefined }
  const jf = journeysFolderName()
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const stage = `${folderName()}/.writing/${id}`
  const stageDir = path.join(repo, stage)
  fs.mkdirSync(stageDir, { recursive: true })
  const cleanup = () => { try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch { /* gone */ } }
  const bundled = skill === bundledSkill()
  const prompt = o.resume ? `${o.resume.reply}\n\n${journeyRules(skill, stage, jf)}` : journeyPrompt(question, skill, stage, jf, bundled)
  const w: Writing = { id, question, started: Date.now(), phase: 'starting', model: modelLabel(model) }
  writingNow.set(id, w)
  writingChanged.fire()
  log.info(`journey: Claude (${w.model}) is writing one for "${question}"${o.resume ? ' (with your answer to its question)' : ''}`)
  let res: AskResult
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing: ${shortQ(question)}`, cancellable: true }, async (progress, token) => {
      // elapsed time and a plain phase, not the tool's name.
      const tick = () => { progress.report({ message: `${clock(Date.now() - w.started)} · ${w.phase}` }); writingChanged.fire() }
      const ask = new Ask({
        cli, cwd: repo, prompt, model, resume: o.resume?.session,
        extraTools: ['Skill', `Bash(${skill}/scripts/*)`], addDirs: [...(fs.existsSync(cache) ? [cache] : []), ...(bundled ? [skill] : [])],
        env: { JOURNEY_MODEL: w.model },
        onProgress: (p) => { const ph = phaseOf(p.tool, w.phase); if (ph !== w.phase) { w.phase = ph; tick() } },
      })
      w.ask = ask
      tick()
      const timer = setInterval(tick, 1000)
      token.onCancellationRequested(() => ask.cancel())
      try { return await ask.done } finally { clearInterval(timer) }
    })
  } finally {
    writingNow.delete(id)
    writingChanged.fire()
  }
  const took = Date.now() - w.started
  if (res.cancelled) { log.info('journey: writing cancelled'); cleanup(); return undefined }
  let files: string[] = []
  try { files = fs.readdirSync(stageDir).filter((f) => f.endsWith('.json')).sort((a, b) => fs.statSync(path.join(stageDir, b)).mtimeMs - fs.statSync(path.join(stageDir, a)).mtimeMs) } catch { /* none */ }
  if (res.error) {
    cleanup()
    void showError(`Code Notes: Claude couldn't write the journey: ${res.error}`)
    return undefined
  }
  if (!files.length) {
    cleanup()
    // no new journey because one already answers it ("… is already in journeys/<slug>.json"): that one opens.
    const named = [...res.text.matchAll(/([\w./-]*journeys)\/([\w.-]+?)\.json/g)]
      .map((m) => [...journeys.list.values()].find((x) => x.j.id === m[2] && relPath(x.folder, x.uri) === `${m[1].replace(/^\.\//, '')}/${m[2]}.json`) ?? [...journeys.list.values()].find((x) => x.j.id === m[2]))
      .find((x): x is LoadedJourney => !!x)
    if (named) {
      log.info(`journey: Claude says "${named.j.title}" (${relPath(named.folder, named.uri)}) already answers "${question}": opening it`)
      void vscode.window.showInformationMessage(`A journey already answers this: ${named.j.title}`)
      await walkJourney(named)
      return named
    }
    // no journey, an answer: Claude asks something first. Shown with a reply box; not an error.
    if (res.text.trim() && res.sessionId) {
      log.info(`journey: Claude asks before writing "${question}": ${res.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
      await showClarify(question, res.sessionId, res.text.trim(), o.model)
      return undefined
    }
    void showError('Code Notes: Claude finished without writing a journey.')
    return undefined
  }
  const slug = files[0].replace(/\.json$/, '')
  if (files.length > 1) log.warn(`journey: Claude wrote ${files.length} journeys (${files.join(', ')}); only ${files[0]} is kept`)
  const staged = path.join(stageDir, files[0])
  const readJ = () => { try { return JSON.parse(fs.readFileSync(staged, 'utf8')) } catch { return undefined } }
  // who wrote it (journey.py's own command; set directly when that one can't).
  await journeyPy(skill, repo, stage, ['meta', repo, slug, 'model', w.model])
  const j0 = readJ()
  if (j0 && j0.model !== w.model) { j0.model = w.model; fs.writeFileSync(staged, JSON.stringify(j0, null, 2) + '\n') }
  const chk = await journeyPy(skill, repo, stage, ['check', repo, slug, 'quiet'])
  if (chk.code !== 0 || !j0) {
    log.error(`journey: "${slug}" didn't pass journey.py check; left in ${stage}/:\n${chk.out}`)
    void showError('Code Notes: the journey Claude wrote didn\'t pass its check, so it wasn\'t added.', 'Show Output').then((b) => { if (b) log.show(true) })
    return undefined
  }
  // Into the journeys folder under a free name, all at once (the list never sees it half-written).
  const destDir = path.join(repo, jf)
  fs.mkdirSync(destDir, { recursive: true })
  let name = slug
  for (let k = 2; fs.existsSync(path.join(destDir, `${name}.json`)); k++) name = `${slug}-${k}`
  if (name !== slug) { const j1 = readJ(); j1.id = name; fs.writeFileSync(staged, JSON.stringify(j1, null, 2) + '\n') }
  const dest = path.join(destDir, `${name}.json`)
  fs.renameSync(staged, dest)
  cleanup()
  const key = vscode.Uri.file(dest).toString()
  let made: LoadedJourney | undefined
  for (let i = 0; i < 30 && !(made = journeys.list.get(key)); i++) await new Promise((r) => setTimeout(r, 100))
  if (!made) { await journeys.load(); made = journeys.list.get(key) ?? [...journeys.list.values()].find((x) => x.j.id === name) }
  const title = made?.j.title ?? j0.title ?? name
  log.info(`journey: written: "${title}" (${jf}/${name}.json) in ${clock(took)} by ${w.model}`)
  // one notice; the map opens by itself unless you are walking another journey.
  void vscode.window.showInformationMessage(`Journey written: ${title} · ${minutes(took)}`, 'Open').then((b) => { if (b && made) void walkJourney(made) })
  if (made && !touring()) await walkJourney(made)
  return made
}

/** Claude's question before it writes a journey: rendered, with a box whose answer resumes the same session. */
let clarify: { panel: vscode.WebviewPanel; question: string; session: string; text: string; model?: string } | undefined
async function showClarify(question: string, session: string, text: string, model?: string): Promise<void> {
  clarify?.panel.dispose()
  let body: string
  const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  try { body = await vscode.commands.executeCommand<string>('markdown.api.render', text) } catch { body = '' }
  if (!body) body = `<pre>${escHtml(text)}</pre>`
  const panel = vscode.window.createWebviewPanel('codeNotes.claudeAsks', 'Claude asks', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true })
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 720px; padding: 8px 16px; }
.q { color: var(--vscode-descriptionForeground); }
.answer { margin: 12px 0; }
textarea { width: 100%; box-sizing: border-box; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; }
button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 12px; margin-top: 6px; cursor: pointer; }
.hint { color: var(--vscode-descriptionForeground); margin-left: 8px; }
</style></head><body>
<p class="q">Before writing a journey for “${escHtml(question)}”, Claude asks:</p>
<div class="answer">${body}</div>
<textarea id="r" rows="4" placeholder="Your answer" aria-label="Your answer to Claude"></textarea>
<div><button id="send">Send</button><span class="hint">Ctrl+Enter</span></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi()
window.addEventListener('error', (e) => vs.postMessage({ type: 'error', text: String(e.message) }))
const r = document.getElementById('r')
const st = vs.getState()
if (st && st.text) r.value = st.text
r.addEventListener('input', () => vs.setState({ text: r.value }))
const send = () => { const t = r.value.trim(); if (t) vs.postMessage({ type: 'reply', text: t }) }
document.getElementById('send').addEventListener('click', send)
r.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } })
r.focus()
</script></body></html>`
  const c = { panel, question, session, text, model }
  clarify = c
  panel.webview.onDidReceiveMessage((m: { type?: string; text?: unknown }) => {
    if (m?.type === 'reply' && typeof m.text === 'string' && m.text.trim()) void answerClarify(m.text)
    else if (m?.type === 'error') log.error(`Claude asks (webview): ${String(m.text)}`)
  })
  panel.onDidDispose(() => { if (clarify === c) clarify = undefined })
}

/** Your answer to Claude's question: the same session goes on and writes the journey. */
async function answerClarify(reply: string): Promise<LoadedJourney | undefined> {
  const c = clarify
  if (!c || !reply.trim()) return undefined
  clarify = undefined
  c.panel.dispose()
  return writeJourney(c.question, { model: c.model, resume: { session: c.session, reply: reply.trim() } })
}

// ---------- requests from scripts: a request file or a link (docs/journey-format.md) ----------
// The script writes.code-notes/.request.json in the repo ({action, question, model, at, id, needs}); the window that
// has the repo open handles it (also when it starts just now) and writes.code-notes/.result.json ({id, outcome, …})
// for the script to print. A request older than 2 minutes is ignored; one that needs a newer Code Notes is left for
// the reloaded window. The vscode://<publisher>.code-notes/explain link (old scripts) still works, but never starts Claude
//: it opens the overview or an existing journey.
interface ExplainRequest { action: 'overview' | 'ask'; question: string; model?: string; id?: string }
const REQUEST_FILE = '.code-notes/.request.json'
const RESULT_FILE = '.code-notes/.result.json'
const REQUEST_MAX_AGE = 2 * 60_000
let lastExplain: { key: string; t: number; res?: { outcome: string; title?: string; model?: string; message?: string } } | undefined
/** What each request did (for the integration test): overview, opened:<id>, confirm, writing, cancelled, untrusted, duplicate. */
const explainLog: { action: string; question: string; via: string; outcome: string }[] = []
/** This extension's version (a request may need a newer one). */
let extVersion = '0.0.0'
const semver = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? ['', '0', '0', '0']).slice(1).map(Number)
const olderThan = (a: string, b: string) => { const x = semver(a), y = semver(b); return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) < 0 }

/** The script's answer (flat, string values), written atomically. */
function writeResult(folder: vscode.WorkspaceFolder, id: string | undefined, r: { outcome: string; title?: string; model?: string; message?: string; text?: string }): void {
  if (!id) return
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const file = path.join(folder.uri.fsPath, RESULT_FILE)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(Object.entries({ id, ...r }).filter(([, v]) => typeof v === 'string'))) + '\n')
    fs.renameSync(tmp, file)
  } catch (e) { log.error(`explain: couldn't write ${RESULT_FILE}: ${e}`) }
}

function journeyScore(x: LoadedJourney, words: string[], typed: string): number {
  const hay = [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()
  const t = [hay, ...x.j.steps.map((st) => st.title.toLowerCase())].join('\n')
  if (!words.every((w) => t.includes(w))) return -1
  const title = x.j.title.toLowerCase()
  return (typed && title === typed ? 1e6 : 0) + (typed && title.startsWith(typed) ? 1e5 : 0) + words.filter((w) => title.includes(w)).length * 1e3 + words.reduce((a, w) => a + t.split(w).length - 1, 0)
}

/** The journey that answers a question: the same question, else the picker's best match on its telling words. */

const journeyText = (x: LoadedJourney) => ({ title: x.j.title, question: x.j.question, summary: x.j.summary, steps: x.j.steps.map((s) => s.title) })
/** Journeys by how well they answer a question: most telling words matched, title and question first. */
function rankJourneys(question: string): { x: LoadedJourney; s: ReturnType<typeof scoreJourney> }[] {
  return journeyOrder().map((x) => ({ x, s: scoreJourney(journeyText(x), question) })).filter((v) => v.s.matched > 0)
    .sort((a, b) => b.s.matched - a.s.matched || b.s.weight - a.s.weight)
}

/**
 * The journeys that answer a question: the same question or title (one), else those matching most of its words; more
 * than one only when the best two are close (then the person picks).
 */
function matchJourneys(question: string): LoadedJourney[] {
  const flat = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const q = flat(question)
  const same = journeyOrder().find((x) => flat(x.j.question) === q || flat(x.j.title) === q)
  if (same) return [same]
  const ok = rankJourneys(question).filter((v) => v.s.answers)
  if (!ok.length) return []
  const top = ok[0].s
  return ok.filter((v, i) => i === 0 || (v.s.matched === top.matched && v.s.weight >= top.weight * 0.85)).slice(0, 4).map((v) => v.x)
}

/** several journeys answer it about equally: a short pick (Esc: none). */
async function chooseJourney(question: string, list: LoadedJourney[]): Promise<LoadedJourney | undefined> {
  type It = vscode.QuickPickItem & { lj: LoadedJourney }
  const qp = vscode.window.createQuickPick<It>()
  qp.title = `Several journeys answer “${shortQ(question, 60)}”`
  qp.placeholder = 'Open one'
  qp.ignoreFocusOut = true
  qp.items = list.map((x) => ({ label: `$(map) ${x.j.title}`, description: x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question, lj: x }))
  return new Promise<LoadedJourney | undefined>((res) => {
    const accept = (it: unknown) => { res((it as It | undefined)?.lj); qp.hide() }
    choosing = { titles: list.map((x) => x.j.title), accept: (t: string) => accept(qp.items.find((i) => i.lj.j.title === t)) }
    qp.onDidAccept(() => accept(qp.selectedItems[0]))
    qp.onDidHide(() => { res(undefined); qp.dispose(); choosing = undefined })
    qp.show()
  })
}
/** The open pick (for the integration test). */
let choosing: { titles: string[]; accept: (title: string) => void } | undefined

/** The pending "Write one with Claude?", for the integration test to answer. */
let confirming: { qp: vscode.QuickPick<vscode.QuickPickItem & { act: unknown }>; question: string; accept: (it: unknown) => void } | undefined
/**
 * before a paid, minutes-long run: the closest journeys first (opening one costs nothing), then Write and Cancel.
 */
async function confirmWrite(question: string, model?: string): Promise<'write' | LoadedJourney | undefined> {
  type It = vscode.QuickPickItem & { act: 'write' | 'cancel' | LoadedJourney }
  const qp = vscode.window.createQuickPick<It>()
  qp.title = `No journey answers this yet. Write one with Claude (${modelLabel(journeyModel(model))}, about 3 min)?`
  qp.placeholder = `“${shortQ(question, 80)}”`
  qp.ignoreFocusOut = true
  qp.matchOnDescription = false
  const alt = rankJourneys(question).slice(0, 3).map((v) => v.x)
  const items: It[] = []
  if (alt.length) {
    items.push({ label: 'Closest journeys', kind: vscode.QuickPickItemKind.Separator, act: 'cancel' })
    for (const x of alt) items.push({ label: `$(map) ${x.j.title}`, description: x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question, act: x })
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, act: 'cancel' })
  }
  items.push({ label: '$(sparkle) Write', description: `a journey for this with Claude (${modelLabel(journeyModel(model))})`, act: 'write' })
  items.push({ label: 'Cancel', act: 'cancel' })
  qp.items = items
  const pick = await new Promise<It | undefined>((res) => {
    const accept = (it: It | undefined) => { res(it); qp.hide() }
    confirming = { qp: qp as unknown as vscode.QuickPick<vscode.QuickPickItem & { act: unknown }>, question, accept: accept as (it: unknown) => void }
    qp.onDidAccept(() => accept(qp.selectedItems[0]))
    qp.onDidHide(() => { res(undefined); qp.dispose() })
    qp.show()
  })
  confirming = undefined
  return !pick || pick.act === 'cancel' ? undefined : pick.act
}

async function handleExplain(req: ExplainRequest, via: string, folder?: vscode.WorkspaceFolder): Promise<void> {
  const key = `${req.action}|${req.question.trim()}`
  const entry = { action: req.action, question: req.question, via, outcome: '' }
  explainLog.push(entry)
  const result = (r: Parameters<typeof writeResult>[2]) => { if (lastExplain?.key === key) lastExplain.res = r; if (folder && via === 'file') writeResult(folder, req.id, r) }
  // The same request just now (an old script's link and file): handled once; the script still gets its answer.
  if (via !== 'command' && lastExplain && lastExplain.key === key && Date.now() - lastExplain.t < 30_000) { entry.outcome = 'duplicate'; if (folder && via === 'file') writeResult(folder, req.id, lastExplain.res ?? { outcome: 'overview' }); return }
  lastExplain = { key, t: Date.now() }
  log.info(`explain (${via}): ${req.action}${req.question ? ` "${req.question}"` : ''}`)
  const q = req.question.trim()
  if (req.action === 'ask' && q) {
    const found = matchJourneys(q)
    if (found.length > 1) {
      entry.outcome = 'choose'
      result({ outcome: 'choose', text: found.map((x) => x.j.title).join(' / ') })
      log.info(`explain: ${found.length} journeys answer it about equally: ${found.map((x) => x.j.id).join(', ')}: a pick`)
      const c = await chooseJourney(q, found)
      if (c) { entry.outcome = `opened:${c.j.id}`; await walkJourney(c, { fromStart: true }) }
      return
    }
    const lj = found[0]
    if (lj) {
      entry.outcome = `opened:${lj.j.id}`
      result({ outcome: 'opened', title: lj.j.title })
      log.info(`explain: opening journey ${lj.j.id}`)
      // A question asks about the whole flow: from step 1, not where it was left.
      await walkJourney(lj, { fromStart: true })
      return
    }
    if (via === 'uri') {
      // a link can come from any web page: it never starts Claude. The overview instead.
      lastExplain = undefined // the same request as a file (from the script) is still handled
      log.info('explain: no journey answers it; a link never starts Claude: the overview')
    } else if (!trusted()) {
      entry.outcome = 'untrusted'
      result({ outcome: 'untrusted', message: 'Trust this folder in VS Code to let Claude write journeys.' })
      claudeAllowed('write journeys')
      return
    } else if (modelProblem(journeyModel(req.model))) {
      const bad = modelProblem(journeyModel(req.model))!
      entry.outcome = 'error'
      result({ outcome: 'error', message: bad })
      void showError(`Code Notes: ${bad}`)
      return
    } else {
      entry.outcome = 'confirm'
      const model = modelLabel(journeyModel(req.model))
      result({ outcome: 'confirm', model })
      const c = await confirmWrite(q, req.model)
      if (c === 'write') {
        entry.outcome = 'writing'
        result({ outcome: 'writing', model })
        void writeJourney(q, { model: req.model }).catch((e) => log.error(`journey: ${e}`))
      } else if (c) {
        entry.outcome = `opened:${c.j.id}`
        result({ outcome: 'opened', title: c.j.title })
        await walkJourney(c, { fromStart: true })
      } else entry.outcome = 'cancelled'
      return
    }
  }
  // Overview: the panel's Journeys list (one marked "Start here"), not a picker; the sidebar is left as it was.
  entry.outcome = 'overview'
  result({ outcome: 'overview' })
  await showJourneysHome()
}

/** The journey panel with its Journeys list in front: over the journey being walked or last shown, else the first one. */
async function showJourneysHome(): Promise<void> {
  const all = journeyOrder()
  const lj = tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? all.find((x) => x.j.start) ?? all[0]
  if (!lj) { void vscode.window.showInformationMessage('Code Notes: no journeys in this workspace yet.'); return }
  // The walk is not ended here (a new card right after an ended walk's made VS Code's comment widgets loop on their
  // collapsed state: "Maximum call stack size exceeded"); choosing a journey switches as usual.
  mapPanel.showHome(lj)
  void state.update(MAP_KEY, posKey(lj))
}

/** A request as the script writes it; undefined (logged) when it can't be used. `model` only from the file. */
function parseExplain(v: any, where: string): ExplainRequest | undefined {
  const action = v?.action
  if (action !== 'overview' && action !== 'ask') { log.warn(`explain: ${where}: unknown action "${String(action)}"`); return undefined }
  const question = typeof v.question === 'string' ? v.question : typeof v.q === 'string' ? v.q : ''
  return { action, question, ...(typeof v.model === 'string' && v.model.trim() ? { model: v.model.trim() } : {}), ...(typeof v.id === 'string' && v.id ? { id: v.id } : {}) }
}

/** vscode://<publisher>.code-notes/explain?action=…&q=…[&repo=<path>] (old scripts): `model` is ignored. */
async function onUri(uri: vscode.Uri): Promise<void> {
  if (uri.path.replace(/\/+$/, '') !== '/explain') { log.warn(`unknown link: ${uri.toString(true)}`); return }
  const p = new URLSearchParams(uri.query)
  const repo = p.get('repo')
  const fs = require('fs') as typeof import('fs')
  const real = (x: string) => { try { return fs.realpathSync(x) } catch { return x } }
  const folder = repo ? (vscode.workspace.workspaceFolders ?? []).find((f) => real(f.uri.fsPath) === real(repo)) : vscode.workspace.workspaceFolders?.[0]
  // Another repository's request: the window that has it open handles it (through the request file).
  if (repo && !folder) { log.info(`explain: a link for ${repo}, not open in this window: left to that window`); return }
  const req = parseExplain({ action: p.get('action'), question: p.get('q') ?? '' }, 'link')
  if (req) await handleExplain(req, 'uri')
}

/** Reads and deletes.code-notes/.request.json, unless it needs a newer Code Notes (left for that window). */
async function consumeRequest(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, REQUEST_FILE)
  let raw: string
  try { raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) } catch { return }
  let v: any
  try { v = JSON.parse(raw) } catch { v = undefined }
  if (v && typeof v.needs === 'string' && olderThan(extVersion, v.needs)) {
    log.info(`explain: the request needs Code Notes ${v.needs} (this is ${extVersion}): left for a reloaded window`)
    explainLog.push({ action: String(v.action), question: String(v.question ?? ''), via: 'file', outcome: 'too-new' })
    return
  }
  try { await vscode.workspace.fs.delete(uri) } catch { /* gone already */ }
  if (!v) { log.warn(`explain: ${REQUEST_FILE} is not JSON: ignored`); return }
  const at = Date.parse(typeof v?.at === 'string' ? v.at : '')
  if (!at || Date.now() - at > REQUEST_MAX_AGE) { log.info(`explain: ${REQUEST_FILE} is ${at ? 'older than 2 minutes' : 'undated'}: ignored`); return }
  const req = parseExplain(v, REQUEST_FILE)
  if (req) await handleExplain(req, 'file', folder)
  else writeResult(folder, typeof v.id === 'string' ? v.id : undefined, { outcome: 'error', message: `unknown action "${String(v.action)}"` })
}

/**
 * Opening a journey walks it (no separate Start): its map, and the code with its card at step 1,
 * or where it was left (the step being walked, else the resume point).
 */
async function walkJourney(lj: LoadedJourney, opts: { fromStart?: boolean; keepFocus?: 'sidebar' | 'panel' } = {}): Promise<void> {
  const fresh = mapPanel.viewColumn === undefined
  await openMap(lj)
  if (!lj.j.steps.length) return
  await goToStep(lj, opts.fromStart ? 1 : tourKey === lj.key && tourStep ? tourStep : resumeAt(lj) || 1)
  // Back where the click was: the code is shown, but arrows and Enter never type into it.
  if (opts.keepFocus === 'sidebar') await vscode.commands.executeCommand('codeNotes.notes.focus').then(undefined, () => undefined)
  else if (opts.keepFocus === 'panel') mapPanel.takeFocus()
  if (fresh) await codeGetsMoreRoom()
}

/**
 * the map just opened beside the code: the code group gets the larger share (60/40), so a step's code and a ref's
 * peek are not cut mid-identifier. Only with exactly the two groups (code, map); a layout the reader made is kept.
 */
async function codeGetsMoreRoom(): Promise<void> {
  const groups = vscode.window.tabGroups.all
  const mapCol = mapPanel.viewColumn
  if (groups.length !== 2 || mapCol === undefined || !groups.some((g) => g.viewColumn === mapCol)) return
  const code = groups.find((g) => g.viewColumn !== mapCol)
  if (!code || !code.tabs.length) return
  const sizes = groups.map((g) => (g.viewColumn === mapCol ? 0.4 : 0.6))
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: sizes.map((size) => ({ size })) }).then(undefined, (e) => log.warn(`layout: ${e}`))
}

/**
 * a file opened in the journey panel's group (Ctrl+P or a link after a click in the panel) moves to the code
 * group, at the same place, so it never covers the journey. Not a group lock: VS Code locks only the active group, and
 * the lock stays on that group after the panel leaves it (then the code's group refused files).
 */
async function keepOffMap(t: vscode.Tab): Promise<void> {
  const mapCol = mapPanel.viewColumn
  if (mapCol === undefined || t.group.viewColumn !== mapCol || !(t.input instanceof vscode.TabInputText)) return
  if (!t.group.tabs.some((x) => x.input instanceof vscode.TabInputWebview && x.input.viewType.endsWith(MAP_VIEW))) return
  const uri = t.input.uri
  // Where Quick Open put the caret (file:line), once its editor is known.
  await new Promise((r) => setTimeout(r, 30))
  const sel = vscode.window.visibleTextEditors.find((e) => e.viewColumn === mapCol && e.document.uri.toString() === uri.toString())?.selection
  const live = vscode.window.tabGroups.all.find((g) => g.viewColumn === mapCol)?.tabs.find((x) => x.input instanceof vscode.TabInputText && x.input.uri.toString() === uri.toString())
  if (!live || live.isDirty) return
  await vscode.window.tabGroups.close(live, true)
  const ed = await vscode.window.showTextDocument(uri, { viewColumn: codeColumn(), preview: live.isPreview, preserveFocus: false })
  if (sel) { ed.selection = sel; ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport) }
}

/** Shows a journey's map. Another journey's tour ends first, keeping its place. */
async function openMap(lj: LoadedJourney): Promise<void> {
  // Another journey's map is only a look: the running tour goes on until Start there, or End.
  await markJourneysSeen(lj)
  if (showIntro()) await gstate.update(INTRO_KEY, true)
  // One journey on screen at a time: another journey's map ends the running walk quietly (its place is kept
  // for Resume); its status item and code marker go with it.
  if (lj.key !== tourKey && touring()) await endTour()
  if (lj.key !== tourKey) { tourKey = lj.key; tourStep = 0 }
  showMap(lj)
  updateTour()
  tree.refresh()
}

function onMapMessage(lj: LoadedJourney, m: MapMessage): void {
  if (m.type === 'step') void goToStep(lj, m.n, { focus: false })
  else if (m.type === 'end') void endTour()
  else if (m.type === 'finish') void finishTour()
  else if (m.type === 'question') { const nt = byId(m.id); if (nt) void reveal(nt) }
  else if (m.type === 'ref') { const r = panelRefs[m.i]; if (r) void openRef(lj, r.file, r.line, r.end, tourStep) }
  else if (m.type === 'ask') void (m.update ? askUpdate() : askStep())
  else if (m.type === 'openPath') void openBoxPath(lj, m.path)
  else if (m.type === 'home') { if (touring()) void endTour() }
  else if (m.type === 'beat') void showBeat(lj, m.n, m.i)
  else if (m.type === 'closed') beats.clear()
  else if (m.type === 'mapWidth') void gstate.update(MAP_WIDTH_KEY, m.w > 0 ? Math.round(m.w) : undefined)
  else if (m.type === 'walk') { const x = journeys.list.get(m.key); if (x) void walkJourney(x, { keepFocus: 'panel' }) }
  else if (m.type === 'details') { stepDetailsOpen = m.open; mapPanel.update() }
  else if (m.type === 'openFile') void vscode.window.showTextDocument(lj.uri, { viewColumn: codeColumn() })
  else if (m.type === 'close') mapPanel.close()
  else if (m.type === 'pick') void vscode.commands.executeCommand('codeNotes.openJourney')
  else if (m.type === 'restore') {
    const raw = journeys.lastGood.get(lj.key)
    if (raw) void vscode.workspace.fs.writeFile(lj.uri, new TextEncoder().encode(raw)).then(() => vscode.window.setStatusBarMessage(`$(check) Restored ${lj.j.title}`, 4000))
  }
  else if (m.type === 'authors') { log.info(`journey ${lj.j.id} (${relPath(lj.folder, lj.uri)}): ${lj.j.problems.length} rule break(s) for its author:\n${lj.j.problems.map((p) => `  - ${p}`).join('\n')}`); log.show(true) }
  else if (m.type === 'tutorial') {
    if (m.action === 'bar') tutorialSeen.bar++
    if (m.action === 'card') { tutorialSeen.card = m.card ?? 0; tutorialSeen.inside = m.inside ? 1 : 0; if (m.editor) void tutorialInEditor(lj, m.editor === 'links' ? 'links' : 'card'); else tutorialOutOfEditor() }
    if (m.action === 'skip' || m.action === 'done') {
      tutorialSeen.card = 0
      tutorialSeen[m.action]++
      tutorialOutOfEditor()
      void gstate.update(TUTORIAL_KEY, true).then(() => mapPanel.update())
    }
    // Finish walks the steps: from where the tour is, else where the map's button would start.
    if (m.action === 'done') void goToStep(lj, touring() && tourKey === lj.key ? tourStep : resumeAt(lj) || 1, { focus: false })
  }
}

/**
 * A beat of the step's animation (i < 0: the scene is gone). Its line is lit; when the scene stops driving the editor
 * (Map, ■, Esc, a beat without code) the editor is given back to the step: its lines and its card.
 */
async function showBeat(lj: LoadedJourney, n: number, i: number): Promise<void> {
  // A beat of a step left just now (the map learns of the move after its scene drew): nothing.
  if (i >= 0 && (lj.key !== tourKey || n !== tourStep)) return
  const was = beats.lit
  // The caret goes to the lit line: arriving is not reading a note there.
  tourCursorUntil = Date.now() + 1500
  const shown = await beats.show(lj.folder.uri, i >= 0 ? lj.j.steps[n - 1]?.scene?.beats[i] : undefined, journeys.renames(lj), codeColumn)
  // The panel shows those lines itself, under the caption, when it has the room.
  if (shown !== 'superseded' && i >= 0) mapPanel.send({ type: 'code', n, i, code: shown === 'lit' ? beats.preview : undefined })
  if (shown === 'none' && was && !stepping && touring() && tourKey === lj.key && tourStep) await goToStep(lj, tourStep, { focus: false })
}

/** Ctrl+' P: the current step's animation on or off, in the journey panel. */
function toggleAnimation(): void {
  const lj = tourJourney()
  if (!lj || !touring()) { void vscode.window.setStatusBarMessage('Open a journey step first: its animation plays in the journey panel.', 4000); return }
  if (!lj.j.steps[tourStep - 1]?.scene?.beats?.length) { void vscode.window.setStatusBarMessage(`Step ${tourStep} has no animation.`, 4000); return }
  if (mapPanel.journey?.key !== lj.key || !mapPanel.visible) showMap(lj, true)
  mapPanel.send({ type: 'anim', action: 'toggle' })
}

/** The tutorial's card about the step card: a step open in the editor (where the walk is, else where it would start),
 *  its lines boxed, so the card above them is found at a glance. */
async function tutorialInEditor(lj: LoadedJourney, what: 'card' | 'links'): Promise<void> {
  // The card itself shows it: its buttons, or its linked phrases, on the search-match colour while the tutorial says so.
  tutorialMark = what
  const n = touring() && tourKey === lj.key && tourStep ? tourStep : resumeAt(lj) || 1
  await goToStep(lj, n, { focus: false })
  const at = lj.at[n - 1]
  // The card moved on while the file opened: nothing.
  if (!at || !tutorialSeen.card) return
  showCard(lj, n)
  tutorialSpot.show(vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n)), at.start - 1, at.end - 1)
}
/** The tutorial left the editor: no box, and the card as it normally looks. */
function tutorialOutOfEditor(): void {
  tutorialSpot.clear()
  if (!tutorialMark) return
  tutorialMark = ''
  const lj = tourJourney()
  if (lj && tourStep) showCard(lj, tourStep)
}
/** What the tutorial is pointing at in the step card now. */
let tutorialMark: '' | 'card' | 'links' = ''
const TUTORIAL_HI = 'var(--vscode-editor-findMatchHighlightBackground)'

/** Code Notes: Journey Tutorial: the map (the tour's, the last one, or picked) with the tutorial from card 1. */
async function tutorial(): Promise<void> {
  const lj = tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? (await pickJourney())
  if (!lj) return
  await openMap(lj)
  mapPanel.send({ type: 'tutorial' })
}

/** Steps whose file was renamed or deleted on disk: follow the code into a file created just now, or go stale. */
async function followJourneyFiles(): Promise<void> {
  for (const lj of journeys.list.values()) {
    let changed = false
    for (const s of lj.j.steps) {
      const f = fileOf(lj, s.n)
      try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(lj.folder.uri, f)); continue } catch { /* gone */ }
      for (const c of recentCreates) {
        if (vscode.workspace.getWorkspaceFolder(c.uri)?.uri.toString() !== lj.folder.uri.toString()) continue
        const ls = await linesOfUri(c.uri)
        // Only the same code (fresh) follows into a new file: edited look-alikes don't.
        if (!ls || journeys.findIn(lj, s.n, ls).state !== 'fresh') continue
        await journeys.moveStep(lj, s.n, relPath(lj.folder, c.uri))
        break
      }
      if (fileOf(lj, s.n) === f && (await journeys.locate(lj, (k) => k === s.n))) changed = true
    }
    if (changed) { mapPanel.update(); if (lj.key === tourKey && tourStep) { await checkRefs(lj, tourStep); showCard(lj, tourStep) } }
  }
  refreshStepDecorations()
}

/**
 * Finish on the last step: the walk ends and starts over next time; the step tab it opened closes, so the map
 * gets its width back. No message.
 */
async function finishTour(): Promise<void> {
  const lj = tourJourney()
  const doc = tourDoc
  await endTour()
  if (!lj) return
  await state.update(POS_KEY, Object.fromEntries(Object.entries(positions()).filter(([k]) => k !== posKey(lj))))
  // Only the walk's own preview tab (not one you kept open or edited).
  const tabs = doc ? vscode.window.tabGroups.all.filter((g) => g.viewColumn === doc.column).flatMap((g) => g.tabs)
    .filter((t) => t.isPreview && !t.isDirty && t.input instanceof vscode.TabInputText && lj.j.steps.some((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).toString() === (t.input as vscode.TabInputText).uri.toString())) : []
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
  finishedKey = lj.key
  showMap(lj)
  updateTour()
  tree.refresh()
}

/** The journey whose walk was just finished: its panel says Done until a step opens again. */
let finishedKey: string | undefined

/** Ends the tour: its place is kept (resume later), the card goes; the code stays open. */
async function endTour(): Promise<void> {
  const lj = tourJourney()
  if (lj && tourStep) await savePos(lj, tourStep)
  await state.update(TOUR_KEY, undefined)
  const doc = tourDoc
  tourDoc = undefined
  codeLinks.clear()
  valueHints.clear()
  beats.clear()
  tourStep = 0
  clearCard()
  updateTour()
  tree.refresh()
  // The code you were reading stays open: you probably ended the tour to keep reading there.
  void doc
}


/** The note box's words. */
const NOTE_OPTIONS: vscode.CommentOptions = { prompt: 'Reply', placeHolder: 'Note or reply…' }

/** "Ask about this step": a normal note on the step's lines. With text (tests, scripts): saved at once; else a box asks for it. */
async function askStep(text?: string): Promise<Note | undefined> {
  const lj = tourJourney()
  if (!lj || !tourStep) { vscode.window.setStatusBarMessage('$(info) No journey step open', 2500); return undefined }
  const s = lj.j.steps[tourStep - 1]
  const at = lj.at[tourStep - 1]
  const uri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, tourStep))
  // The step by its id and title: numbers change when the journey is edited.
  const about = `_About the step “${s.title}” (id \`${s.id}\`) of the journey “${lj.j.title}”_`
  if (typeof text === 'string' && text.trim()) {
    const doc = await vscode.workspace.openTextDocument(uri)
    const n = await createNote(doc, { start: at.start - 1, end: at.end - 1 }, `${text.trim()}\n\n${about}`, undefined, { journey: { id: lj.j.id, step: s.id, n: tourStep } })
    // An update request is about the step's code as written, not whatever sits at those lines now: it carries the
    // journey's copy of that code and is stale from the start.
    const was = journeys.anchorOf(lj, tourStep)
    if (n && at.stale && was && 'text' in was) { n.data.anchor = { ...n.data.anchor, ...was }; n.data.stale = true; await store.save(n); refreshAll() }
    if (n && claudeMode() === 'always') await askClaude(n)
    return n
  }
  // a box of its own, not the editor's comment box (that one needed the cursor on the step's line and could
  // lose what was typed). Esc keeps the draft for the next Ask on this step.
  const n0 = tourStep
  const dk = `${lj.j.id}|${s.id}`
  const box = vscode.window.createInputBox()
  box.title = `Ask about step ${n0}/${lj.j.steps.length}: ${s.title}`
  box.placeholder = 'Your question'
  box.prompt = 'Enter asks · Esc keeps the draft'
  box.ignoreFocusOut = true
  box.value = askDrafts.get(dk) ?? ''
  const typed = await new Promise<string | undefined>((res) => {
    let done = false
    const accept = () => { if (!box.value.trim()) return; done = true; res(box.value); box.hide() }
    stepAskBox = { box, accept }
    box.onDidChangeValue((v) => { if (v.trim()) askDrafts.set(dk, v); else askDrafts.delete(dk) })
    box.onDidAccept(accept)
    box.onDidHide(() => { if (!done) res(undefined); box.dispose(); if (stepAskBox?.box === box) stepAskBox = undefined })
    box.show()
  })
  if (!typed?.trim()) return undefined
  // The walk moved on while typing: the question is still about the step it was asked on.
  const lj2 = tourJourney()
  if (lj2 !== lj || tourStep !== n0) { askDrafts.set(dk, typed); vscode.window.setStatusBarMessage('$(info) The step changed: your question is kept for it', 4000); return undefined }
  const note = await askStep(typed)
  if (!note) return undefined
  askDrafts.delete(dk)
  // the note's thread, open, with the live answer in it (the status bar is only a second cue).
  await reveal(note, vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn ?? codeColumn())
  if (claudeMode() === 'button' && findCli(cfg().get<string>('claude.path') || undefined)) void askClaude(note)
  return note
}
/** Questions typed on a step and not sent yet (Esc), by journey|step id. */
const askDrafts = new Map<string, string>()
/** The open Ask box (for the integration test). */
let stepAskBox: { box: vscode.InputBox; accept: () => void } | undefined

/**
 * "Ask the agent to fix it": the request opens prefilled, to add what you know (e.g. where the code went);
 * Enter saves it as a note on the step (`journey`: {id, step, n}, which the code-journey skill acts on), Esc cancels.
 */
async function askUpdate(): Promise<Note | undefined> {
  const lj = tourJourney()
  if (!lj || !tourStep) return undefined
  const n = tourStep
  const text = await vscode.window.showInputBox({
    title: `Ask the agent to update step ${n}/${lj.j.steps.length}: ${lj.j.steps[n - 1].title}`, value: UPDATE_ASK,
    valueSelection: [UPDATE_ASK.length, UPDATE_ASK.length], prompt: 'Add what you know (where it moved, what changed). Enter saves the note; Esc cancels.',
  })
  if (!text?.trim() || tourStep !== n || tourJourney() !== lj) return undefined
  const note = await askStep(text)
  if (note) { vscode.window.setStatusBarMessage('$(check) Asked the agent to update this step', 3000); showCard(lj, n); mapPanel.update() }
  return note
}

/** A box without steps (a store): open what its `path` names: a file, else the folder in the Explorer. */
async function openBoxPath(lj: LoadedJourney, p: string): Promise<void> {
  // `path`, or `file:a-b` (a function box's code, 0.21): the lines selected.
  const lines = /:(\d+)(?:-(\d+))?$/.exec(p)
  const uri = vscode.Uri.joinPath(lj.folder.uri, p.replace(/:\d+(-\d+)?$/, ''))
  try {
    const st = await vscode.workspace.fs.stat(uri)
    if (st.type & vscode.FileType.Directory) await vscode.commands.executeCommand('revealInExplorer', uri)
    else {
      const a = lines ? Math.max(0, Number(lines[1]) - 1) : 0, b = lines ? Math.max(a, Number(lines[2] ?? lines[1]) - 1) : 0
      await vscode.window.showTextDocument(uri, { preview: true, viewColumn: codeColumn(), ...(lines ? { selection: new vscode.Range(a, 0, b, 0) } : {}) })
    }
  } catch { vscode.window.setStatusBarMessage(`$(info) ${p} isn't in this folder`, 3000) }
}

/** A reference from the step card: open it with its lines lit and "← Back to step n" above them (R8). */
async function openRef(lj: LoadedJourney, file: string, line: number, end: number, n: number): Promise<void> {
  lastPeek = undefined
  const uri = vscode.Uri.joinPath(lj.folder.uri, file)
  try { await vscode.workspace.fs.stat(uri) } catch { void showError(`Code Notes: ${file} doesn't exist in this folder.`); return }
  // The inline card lives in the step's tab: a ref opens as a peek right under the card, so the tab, the code and the
  // card stay. Esc closes it. A ref into the step's own file peeks a read-only copy (REF_SCHEME): a peek of the
  // file itself embeds a second editor on it, with its own copy of the card's thread, and closing that peek collapsed
  // the card in the step's editor too.
  const stepUri0 = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n))
  const stepEd = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === stepUri0.toString())
  if (stepEd && !stepFileGone) {
    const same = uri.toString() === stepUri0.toString()
    const target = same ? refCopyUri(uri) : uri
    const doc = await vscode.workspace.openTextDocument(target)
    const a = Math.max(0, Math.min(line - 1, doc.lineCount - 1)), b = Math.max(a, Math.min(end - 1, doc.lineCount - 1))
    const at = lj.at[n - 1]
    // Right under the step card: the card's own line, not the end of the step's code.
    const under = new vscode.Position(Math.max(0, Math.min(at.removed ? 0 : cardLine(lj, n), stepEd.document.lineCount - 1)), 0)
    await vscode.window.showTextDocument(stepEd.document, { viewColumn: stepEd.viewColumn, preview: true, preserveFocus: false })
    lastPeek = { uri: target.toString(), start: a, end: b, under: under.line }
    await vscode.commands.executeCommand('editor.action.peekLocations', stepUri0, under, [new vscode.Location(target, new vscode.Range(a, 0, b, doc.lineAt(b).text.length))], 'peek')
    return
  }
  // Go Back (Alt+Left) lands on the step's lines: the editor is left from there.
  if (stepEd) { const at = lj.at[n - 1]; const l = Math.max(0, (at.removed ? 1 : at.start) - 1); stepEd.selection = new vscode.Selection(l, 0, l, 0) }
  const ed = await vscode.window.showTextDocument(uri, { preview: true, viewColumn: codeColumn() })
  const a = Math.max(0, Math.min(line - 1, ed.document.lineCount - 1)), b = Math.max(a, Math.min(end - 1, ed.document.lineCount - 1))
  refHere = { uri: uri.toString(), start: a, end: b }
  ed.selection = new vscode.Selection(a, 0, a, 0)
  ed.revealRange(new vscode.Range(Math.max(0, a - 1), 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  for (const e of vscode.window.visibleTextEditors) e.setDecorations(refDeco!, e.document.uri.toString() === refHere.uri ? [new vscode.Range(a, 0, b, 0)] : [])
  lensChanged.fire()
  void n
}

/**
 * While walking: "← Back to step n" above an opened ref (R8). Outside a walk: one quiet line above the code a
 * journey step is about, "◇ Step 3 of Place an order" (only where its code is found); click = that step.
 */
function stepLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  if (touring()) {
    const lj = tourJourney()!
    if (!refHere || refHere.uri !== doc.uri.toString()) return []
    const n = tourStep
    return [new vscode.CodeLens(new vscode.Range(refHere.start, 0, refHere.start, 0), { title: `← Back to step ${n}`, command: 'codeNotes.backToStep', tooltip: lj.j.steps[n - 1].title })]
  }
  if (!cfg().get<boolean>('journeys.codeLens', true) || doc.uri.scheme !== 'file') return []
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder || inNotesFolder(doc.uri)) return []
  const rel = relPath(folder, doc.uri)
  const out: vscode.CodeLens[] = []
  for (const lj of journeys.all()) {
    if (lj.folder.uri.toString() !== folder.uri.toString()) continue
    for (const s of lj.j.steps) {
      const at = lj.at[s.n - 1]
      if (!at || at.stale || fileOf(lj, s.n) !== rel) continue
      out.push(new vscode.CodeLens(new vscode.Range(at.start - 1, 0, at.start - 1, 0), { title: `◇ Step ${s.n} of ${lj.j.title}`, command: 'codeNotes.openStepLink', arguments: [lj.j.id, s.id, s.n], tooltip: s.title }))
    }
  }
  return out
}

/** After a reload: the tour where it was. The map comes back by itself when it was open (serializer). */
async function restoreTour(): Promise<void> {
  const lj = journeys.byPos(state.get<string>(TOUR_KEY))
  if (!lj) return
  const n = resumeAt(lj) || 1
  if (!mapPanel.journey) { tourKey = lj.key }
  await goToStep(lj, n, { focus: false })
}

// ---------- commands ----------

/** The notes a command is about: sidebar selection, a tree node, a comment thread or reply, or the note at the cursor. */
function notesFrom(arg: any, many?: any[]): Note[] {
  const fromNode = (x: any): Note | undefined => (x?.kind === 'note' ? x.note : undefined)
  if (Array.isArray(many) && many.length > 1) return many.map(fromNode).filter((n): n is Note => !!n)
  if (arg?.kind === 'note') return [arg.note]
  if (typeof arg === 'string') { const n = byId(arg); return n ? [n] : [] } // a link in the thread
  if (arg?.thread) { const n = noteOfThread(arg.thread); return n ? [n] : [] }
  if (arg && typeof arg === 'object' && 'uri' in arg && 'range' in arg) { const n = noteOfThread(arg as vscode.CommentThread); return n ? [n] : [] }
  const editor = vscode.window.activeTextEditor
  if (!editor) return []
  const line = editor.selection.active.line + 1
  const here = notesAtCursor(editor)
  if (revealedId) { const r = here.find((n) => n.data.id === revealedId); if (r) return [r] }
  return here.slice(0, 1)
}

/** Notes covering the cursor line, innermost (smallest) first. */
function notesAtCursor(editor: vscode.TextEditor): Note[] {
  const line = editor.selection.active.line + 1
  const span = (n: Note) => n.data.range.end - n.data.range.start
  return notesFor(editor.document.uri).filter((n) => line >= n.data.range.start && line <= n.data.range.end)
    .sort((a, b) => span(a) - span(b) || order(a, b))
}

/** For palette commands: the note at the cursor, asking which when several overlap. */
async function target(arg: any, many?: any[]): Promise<Note[]> {
  if (arg !== undefined || many) return notesFrom(arg, many)
  const editor = vscode.window.activeTextEditor
  const here = editor ? notesAtCursor(editor) : []
  if (!here.length) { vscode.window.setStatusBarMessage('$(info) No note at the cursor', 2500); return [] }
  if (here.length === 1) return here
  const pick = await vscode.window.showQuickPick(here.map((n) => ({ label: plain(n.data.messages[0]?.body ?? '', 70), description: lines(n), note: n })), { title: 'Which note?' })
  return pick ? [pick.note] : []
}

function newId(): string {
  return now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6)
}

/** The selected text, when the selection is only part of its lines (a token, an expression). */
function partialSelection(doc: vscode.TextDocument, r: vscode.Range): NoteData['selection'] {
  if (r.isEmpty) return undefined
  const lead = (line: number, col: number) => !doc.lineAt(line).text.slice(0, col).trim()
  const whole = lead(r.start.line, r.start.character) && (lead(r.end.line, r.end.character) || r.end.character >= doc.lineAt(r.end.line).text.length)
  if (whole) return undefined
  const text = doc.getText(r)
  return text.trim() ? { text, startCol: r.start.character, endCol: r.end.character } : undefined
}

async function createNote(doc: vscode.TextDocument, loc: Loc, body: string, selection?: NoteData['selection'], extra?: Record<string, unknown>): Promise<Note | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder) { void showError('Code Notes: save the file inside the open folder to add notes to it.'); return undefined }
  if (inNotesFolder(doc.uri)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return undefined }
  const at = now()
  const id = newId()
  const n: Note = {
    folder, uri: store.uriFor(folder, id),
    data: {
      id, file: relPath(folder, doc.uri), range: { start: loc.start + 1, end: loc.end + 1 },
      anchor: { ...captureAnchor(linesOf(doc), loc.start, loc.end), ...(await commitInfo(folder)) },
      ...(selection ? { selection } : {}), status: 'open', stale: false, createdAt: at,
      messages: [{ author: me(), role: 'human', body, at }],
      ...(extra ? { extra } : {}),
    },
  }
  // Written on unsaved text (a typo being fixed): the saved lines count too, so undoing the typo isn't "stale".
  if (doc.isDirty && doc.uri.scheme === 'file') {
    const disk = await linesOfDisk(doc.uri)
    if (disk && disk.length === doc.lineCount && loc.end < disk.length) {
      const a = captureAnchor(disk, loc.start, loc.end)
      if (a.text !== n.data.anchor.text) otherAnchor.set(id, { ...n.data.anchor, ...a })
    }
  }
  if (!(await store.save(n))) return undefined
  await setSeen([[id, 1]])
  shape.set(id, shapeOf(n))
  refreshAll()
  // No "Note saved": the note is there, in its thread and the list.
  return n
}

/** Commenting ranges: none, except while a note box is being opened (`addingUntil`). */
let addingUntil = 0
const rangeProvider: vscode.CommentingRangeProvider = {
  provideCommentingRanges: (doc) => (Date.now() < addingUntil && vscode.workspace.getWorkspaceFolder(doc.uri) && doc.lineCount && !inNotesFolder(doc.uri)
    ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []),
}
let rangesOff: NodeJS.Timeout | undefined
async function allowComments(ms = 1500): Promise<void> {
  addingUntil = Date.now() + ms
  controller.commentingRangeProvider = rangeProvider
  clearTimeout(rangesOff)
  rangesOff = setTimeout(() => { controller.commentingRangeProvider = rangeProvider }, ms + 50)
  await new Promise((r) => setTimeout(r, 120))
}

/** Ctrl+< C: VS Code's inline comment box at the selection (multi-line, markdown, Ctrl+Enter saves). */
async function addNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  if (inNotesFolder(editor.document.uri)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return }
  if (!vscode.workspace.getWorkspaceFolder(editor.document.uri) || editor.document.isUntitled) {
    void showError('Code Notes: save the file inside the open folder to add notes to it.')
    return
  }
  await allowComments()
  try { await vscode.commands.executeCommand('workbench.action.addComment') } catch { await addQuickNote(); return }
  // VS Code scrolls to the top of the selection, but the note box opens under its LAST line: on a big block that is
  // off screen. Bring the last line (and the box below it) into view, unless it already is with room to spare.
  const end = selectedLines(editor).end
  const showBox = () => {
    const vis = editor.visibleRanges[0]
    const roomBelow = vis ? vis.end.line - end : 0
    if (!vis || end < vis.start.line || roomBelow < 12) {
      editor.revealRange(new vscode.Range(end, 0, end, 0), vscode.TextEditorRevealType.InCenter)
    }
  }
  showBox()
  setTimeout(showBox, 150) // again once the widget has been laid out
}

/** No text editor (the first click on "Add a Note"): say what to do instead of doing nothing. */
async function noEditor(): Promise<void> {
  const pick = await vscode.window.showInformationMessage(`Open a file and select code, then press ${KEY} C.`, 'Open File…')
  if (pick) await vscode.commands.executeCommand('workbench.action.quickOpen')
}

/** A note on a whole file or folder: from the explorer, the editor tab, or the palette (the active file). */
async function addPathNote(uri?: vscode.Uri, text?: string): Promise<Note | undefined> {
  uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri)
  if (!uri || !folder) { vscode.window.setStatusBarMessage('$(info) Pick a file or folder in the Explorer first', 3000); return undefined }
  if (inNotesFolder(uri) || uri.path.endsWith(`/${folderName()}`)) { vscode.window.setStatusBarMessage('$(info) No notes on Code Notes\' own files', 3000); return undefined }
  const file = relPath(folder, uri)
  if (!file || file === '.') { vscode.window.setStatusBarMessage('$(info) Notes go on a file or a folder inside the workspace', 3000); return undefined }
  let isDir = false
  try { isDir = !!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) } catch { return undefined }
  const body = text ?? (await vscode.window.showInputBox({ title: `Note on ${isDir ? 'folder' : 'file'} ${file}${isDir ? '/' : ''}`, placeHolder: 'Your note or question', ignoreFocusOut: true }))?.trim()
  if (!body) return undefined
  const at = now()
  const id = newId()
  const n: Note = {
    folder, uri: store.uriFor(folder, id),
    data: {
      id, file, range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' }, target: isDir ? 'folder' : 'file',
      status: 'open', stale: false, createdAt: at, messages: [{ author: me(), role: 'human', body, at }],
    },
  }
  if (!(await store.save(n))) return undefined
  await setSeen([[id, 1]])
  shape.set(id, shapeOf(n))
  refreshAll()
  await reveal(n)
  if (claudeMode() === 'always') await askClaude(n)
  return n
}

/** Apply on an agent's ```suggestion block: replaces the note's lines; the editor's Undo takes it back. */
async function applySuggestion(id: string, mi: number, k: number): Promise<boolean> {
  const n = byId(id)
  const text = n ? suggestionOf(n.data.messages[mi]?.body ?? '', k) : undefined
  if (!n || text === undefined) { vscode.window.setStatusBarMessage('$(info) That suggestion is gone', 3000); return false }
  if (n.data.target) { void showError('Code Notes: a suggestion needs a note on lines, not a whole file.'); return false }
  if (n.data.stale || missing.has(n.data.id) || pastEnd.has(n.data.id)) {
    void showError('Code Notes: the code changed since this suggestion, so it was not applied. Check it, then Keep Note Here and apply again.')
    return false
  }
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const start = n.data.range.start - 1, end = Math.min(n.data.range.end - 1, doc.lineCount - 1)
  // A note whose anchor was lost (an agent rewrote the file from an older copy): take it now, so Undo has the old code.
  if (!n.data.anchor.text && !n.data.anchor.before && !n.data.anchor.after) n.data.anchor = { ...captureAnchor(linesOf(doc), start, end), ...(await commitInfo(n.folder)) }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text)
  if (!(await vscode.workspace.applyEdit(edit))) { void showError('Code Notes: the suggestion could not be applied.'); return false }
  // The note now covers the new lines (not stale: this is the change it asked for).
  const newEnd = start + text.split('\n').length - 1
  n.data.range = { start: start + 1, end: newEnd + 1 }
  otherAnchor.set(n.data.id, n.data.anchor)
  n.data.anchor = { ...captureAnchor(linesOf(doc), start, newEnd), ...(await commitInfo(n.folder)) }
  n.data.stale = false
  if (n.data.selection && !n.data.anchor.text.includes(n.data.selection.text)) delete n.data.selection
  const ed = await vscode.window.showTextDocument(doc, { preview: false })
  ed.selection = new vscode.Selection(start, 0, start, 0)
  refreshAll()
  vscode.window.setStatusBarMessage(`$(check) Applied to ${lines(n)}. Save to keep; Ctrl+Z undoes.`, 5000)
  return true
}

/** A one-line note in the command bar (Enter saves). */
async function addQuickNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return noEditor()
  const loc = selectedLines(editor)
  const doc = editor.document
  const box = vscode.window.createInputBox()
  box.title = `Note on ${vscode.workspace.asRelativePath(doc.uri)} ${loc.start === loc.end ? `line ${loc.start + 1}` : `lines ${loc.start + 1}–${loc.end + 1}`}`
  box.placeholder = 'Your note or question'
  box.prompt = doc.lineAt(loc.start).text.trim().slice(0, 80) // the code it is about; VS Code adds the Enter/Esc hint
  box.ignoreFocusOut = true
  box.onDidChangeValue(() => { box.validationMessage = undefined })
  box.onDidAccept(async () => {
    const body = box.value.trim()
    if (!body) { box.validationMessage = 'Type a note first (Esc cancels)'; return }
    box.hide()
    await createNote(doc, loc, body, partialSelection(doc, editor.selection))
  })
  box.onDidHide(() => box.dispose())
  box.show()
}

/** The last undoable action: the toast's Undo, and "Code Notes: Undo" after the toast is gone. */
let lastUndo: { what: string; run: () => Promise<void> } | undefined
function offerUndo(what: string, run: () => Promise<void>, quiet = false): void {
  const entry = { what, run }
  lastUndo = entry
  setCtx('codeNotes.canUndo', true)
  // Quiet: nothing pops up; "Code Notes: Undo" still brings it back.
  if (!quiet) void vscode.window.showInformationMessage(what, 'Undo').then((pick) => { if (pick === 'Undo') return undoLast(entry) })
}
async function undoLast(entry = lastUndo): Promise<void> {
  if (!entry || entry !== lastUndo) return // already undone
  lastUndo = undefined
  setCtx('codeNotes.canUndo', false)
  await entry.run()
  vscode.window.setStatusBarMessage(`$(discard) Undone: ${entry.what}`, 3000)
}

async function setStatus(list: Note[], status: 'open' | 'resolved', record = true): Promise<void> {
  for (const n of list) {
    const before = structuredClone(n.data)
    if (record && n.data.status !== status) addEvent(n, status === 'resolved' ? 'resolved' : 'reopened')
    n.data.status = status
    checked.delete(n.data.id)
    // Not saved (a file another user wrote): the note stays as the file says; the error says why.
    if (!(await store.save(n))) n.data = before
    shape.set(n.data.id, shapeOf(n))
  }
  refreshAll()
}

async function resolve(list: Note[], scope = ''): Promise<void> {
  list = list.filter((n) => n.data.status === 'open' || unread(n) > 0)
  if (!list.length) return
  const withUnread = list.filter((n) => unread(n) > 0)
  if (list.length > 1 && withUnread.length) {
    const titles = list.slice(0, 5).map((n) => `• ${plain(n.data.messages[0]?.body ?? '', 60)}`).join('\n') + (list.length > 5 ? `\n… and ${list.length - 5} more` : '')
    const ok = await vscode.window.showWarningMessage(`Resolve ${list.length} notes${scope}? ${withUnread.length} unread.`, { modal: true, detail: titles }, 'Resolve')
    if (ok !== 'Resolve') return
  }
  if (revealedId && list.some((n) => n.data.id === revealedId)) revealedId = undefined
  const seenBefore = Object.fromEntries(list.map((n) => [n.data.id, seenCount(n)]))
  await markRead(list)
  await setStatus(list, 'resolved')
  offerUndo(`Resolved ${list.length === 1 ? `"${plain(list[0].data.messages[0]?.body ?? '', 40)}"` : `${list.length} notes`}`, async () => {
    await setSeen(Object.entries(seenBefore))
    await setStatus(list.map(undoResolveEvent), 'open', false)
  })
}

/** Undoing a resolve: the resolve leaves no trace in the history. */
function undoResolveEvent(n: Note): Note {
  const last = n.data.events?.[n.data.events.length - 1]
  if (last?.type === 'resolved' && evMine(last)) { n.data.events = n.data.events!.slice(0, -1); if (!n.data.events.length) delete n.data.events }
  return n
}

async function trash(list: Note[], what: string): Promise<void> {
  for (const n of list) { checked.delete(n.data.id); await store.trash(n) }
  refreshAll()
  offerUndo(`Deleted ${what}`, async () => { for (const n of list) await store.restore(n); refreshAll() })
}

/** A note whose file is gone, as a read-only document (never an unsaved Untitled buffer:). */
const ORPHAN_SCHEME = 'code-notes-note'
function orphanMarkdown(n: Note): string {
  return [`# ${plain(n.data.messages[0]?.body ?? 'Note', 80)}`, '', `_${n.data.file} ${lines(n)} no longer exists._`, '',
    ...(n.data.anchor.text.trim() ? ['It was about:', '', '```', n.data.anchor.text, '```', ''] : []),
    ...n.data.messages.flatMap((m) => [`**${m.author}** ${m.at ? m.at.slice(0, 16).replace('T', ' ') : ''}`, '', m.body, ''])].join('\n')
}

async function reveal(n: Note, column?: vscode.ViewColumn): Promise<void> {
  revealInList(n)
  if (missing.has(n.data.id)) {
    const uri = vscode.Uri.from({ scheme: ORPHAN_SCHEME, path: `/${n.data.file.split('/').pop()} (note).md`, query: n.data.id })
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true })
    await markRead([n])
    const pick = await vscode.window.showWarningMessage(`${n.data.file} no longer exists. Select the code this note belongs to, then use Move.`, 'Move…', 'Resolve')
    if (pick === 'Move…') await startMove(n)
    else if (pick === 'Resolve') await resolve([n])
    return
  }
  const prev = revealedId
  revealedId = n.data.id
  for (const id of [...visitFrom.keys()]) if (id !== n.data.id) visitFrom.delete(id)
  if (prev && prev !== n.data.id) { const p = byId(prev); if (p) syncThread(p) }
  // Never in the map's group: the code group, reusing its preview tab.
  const col = column ?? (vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === docUri(n).toString()) ? columnFor(docUri(n))
    : mapPanel.viewColumn !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn === mapPanel.viewColumn ? codeColumn() : undefined)
  const editor = await vscode.window.showTextDocument(docUri(n), { preview: true, ...(col ? { viewColumn: col } : {}) })
  const r = threadRange(n)
  editor.selection = new vscode.Selection(r.start, r.start)
  editor.revealRange(new vscode.Range(r.start, r.end.translate(4)), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  syncThread(n)
  // Only this note's thread is open: others on the same lines collapse, so the one clicked is the one shown.
  for (const other of notesFor(docUri(n))) {
    const t = threads.get(other.data.id)
    if (!t) continue
    const overlaps = other.data.range.start <= n.data.range.end && other.data.range.end >= n.data.range.start
    if (other === n) setCollapse(t, vscode.CommentThreadCollapsibleState.Expanded, other.data.id)
    else if (overlaps) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, other.data.id)
  }
  await markRead([n], n)
}

/** Selects the note's row in the sidebar, when the sidebar is open. */
function revealInList(n: Note): void {
  if (!treeView.visible || !matchesFilter(n)) return
  treeView.reveal(noteNode(n), { select: true, focus: false }).then(undefined, () => { /* not in the list */ })
}

/** Next/previous note with unread replies after the cursor, across files in the sidebar's order. Hidden sessions are skipped. */
async function stepUnread(dir: 1 | -1): Promise<void> {
  const list = notes().filter((n) => (unread(n) > 0 || visitFrom.has(n.data.id)) && !hiddenSessions().has(sessionOf(n)))
    .sort((a, b) => a.data.file.localeCompare(b.data.file) || order(a, b))
  const pending = list.filter((n) => unread(n) > 0)
  // With a map open, say what D does outside a tour, and how to walk the steps instead.
  if (!pending.length) { vscode.window.setStatusBarMessage(mapPanel.journey ? '$(check) No unread replies · to walk the steps, press ▶ on the map' : '$(check) No unread replies', 4000); return }
  const e = vscode.window.activeTextEditor
  const here = e ? { file: notesFor(e.document.uri)[0]?.data.file ?? relPath(vscode.workspace.getWorkspaceFolder(e.document.uri) ?? n0(), e.document.uri), line: e.selection.active.line + 1 } : undefined
  const key = (n: Note) => [n.data.file, n.data.range.start] as const
  const after = (n: Note) => !here || (dir === 1
    ? key(n)[0] > here.file || (key(n)[0] === here.file && key(n)[1] > here.line)
    : key(n)[0] < here.file || (key(n)[0] === here.file && key(n)[1] < here.line))
  const ordered = dir === 1 ? pending : [...pending].reverse()
  await reveal(ordered.find(after) ?? ordered[0])
}
const n0 = () => vscode.workspace.workspaceFolders![0]

async function startMove(n: Note): Promise<void> {
  pendingMove = n.data.id
  setCtx('codeNotes.moving', true)
  moveItem.text = `$(move) Move "${plain(n.data.messages[0]?.body ?? '', 30)}" to the selection`
  moveItem.tooltip = 'Select the code, then click here. Esc cancels.'
  moveItem.show()
  const pick = await vscode.window.showInformationMessage(`Move note "${plain(n.data.messages[0]?.body ?? '', 40)}": select the code it belongs to, then click Move Here.`, 'Move Here', 'Cancel')
  if (pick === 'Move Here') await completeMove()
  else if (pick === 'Cancel') cancelMove()
}

function cancelMove(): void {
  pendingMove = undefined
  setCtx('codeNotes.moving', false)
  moveItem.hide()
}

async function completeMove(): Promise<void> {
  const n = pendingMove ? byId(pendingMove) : undefined
  const editor = vscode.window.activeTextEditor
  if (!n) { cancelMove(); return }
  if (!editor || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
    vscode.window.setStatusBarMessage('$(info) Select the code in an editor first', 2500)
    return
  }
  const before = JSON.parse(JSON.stringify(n.data)) as NoteData
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)!
  const loc = selectedLines(editor)
  n.folder = folder
  n.data.file = relPath(folder, editor.document.uri)
  n.data.range = { start: loc.start + 1, end: loc.end + 1 }
  // The new code, its branch, and the exact text if only part of a line is selected.
  n.data.anchor = { ...captureAnchor(linesOf(editor.document), loc.start, loc.end), ...(await commitInfo(folder)) }
  const sel = partialSelection(editor.document, editor.selection)
  if (sel) n.data.selection = sel; else delete n.data.selection
  n.data.stale = false
  missing.delete(n.data.id)
  pastEnd.delete(n.data.id)
  cancelMove()
  await store.save(n)
  refreshAll()
  offerUndo(`Note moved to ${n.data.file} ${lines(n)}`, async () => { n.data = before; await store.save(n); await reanchorAll(); refreshAll() })
}

let currentFolder = '.code-notes'

/** The notes folder setting changed: offer to move the notes there, so they don't silently disappear. */
async function changeFolder(): Promise<void> {
  const raw = cfg().get<string>('folder') || '.code-notes'
  const problem = folderProblem(raw)
  if (problem) void showError(`Code Notes: the folder "${raw}" can't be used: ${problem}. Using .code-notes.`)
  const from = currentFolder, to = folderName()
  currentFolder = to
  if (from === to) return
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const oldDir = vscode.Uri.joinPath(f.uri, from)
    let files: [string, vscode.FileType][] = []
    try { files = (await vscode.workspace.fs.readDirectory(oldDir)).filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json') && !n.startsWith('.')) } catch { continue }
    if (!files.length) continue
    const pick = await vscode.window.showWarningMessage(`Move ${files.length} note${files.length === 1 ? '' : 's'} from ${from}/ to ${to}/?`,
      { modal: true, detail: `Cancel leaves them in ${from}/, where Code Notes no longer shows them.` }, 'Move Notes')
    if (pick !== 'Move Notes') continue
    const newDir = vscode.Uri.joinPath(f.uri, to)
    await vscode.workspace.fs.createDirectory(newDir)
    for (const [name] of files) await vscode.workspace.fs.rename(vscode.Uri.joinPath(oldDir, name), vscode.Uri.joinPath(newDir, name), { overwrite: false })
    // The trash moves too; the old README and.gitignore go, so no agent writes into a dead folder.
    try { await vscode.workspace.fs.rename(vscode.Uri.joinPath(oldDir, '.trash'), vscode.Uri.joinPath(newDir, '.trash'), { overwrite: false }) } catch { /* none */ }
    for (const name of ['README.md', '.gitignore']) try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(oldDir, name)) } catch { /* none */ }
    try { if (!(await vscode.workspace.fs.readDirectory(oldDir)).length) await vscode.workspace.fs.delete(oldDir) } catch { /* keep */ }
    await store.writeGitignore(f)
    vscode.window.setStatusBarMessage(`$(check) Moved ${files.length} notes to ${to}/`, 4000)
  }
  await store.load()
  await journeys.load()
  for (const f of vscode.workspace.workspaceFolders ?? []) if (notes().some((n) => n.folder === f)) await store.writeReadme(f)
  if (!notes().length) treeView.message = `Reading notes from ${to}/`
}

/** The "keep notes out of git" setting changed: add or remove the notes folder's.gitignore now. */
async function applyIgnoreInGit(): Promise<void> {
  const on = cfg().get<boolean>('ignoreInGit', true)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(f.uri, folderName())) } catch { continue }
    await store.writeGitignore(f) // shared through git: still not the trash
  }
  // Said once (no lasting status-bar item); after that it is in the notes item's tooltip.
  const k = `codeNotes.gitSaid.${on}`
  if (!gstate.get<boolean>(k)) {
    await gstate.update(k, true)
    vscode.window.setStatusBarMessage(on ? `$(eye-closed) Notes in ${folderName()}/ are kept out of git` : `$(git-commit) Notes in ${folderName()}/ can now be committed`, 4000)
  }
  refreshAll()
}

function agentPrompt(list?: Note[]): string {
  const dir = folderName()
  // No frozen timestamp: a prompt pasted an hour later must not date replies in the past.
  const rules = `Format and rules: ${dir}/README.md. I'm ${me()}. Use the current time for "at". If a note is "stale", the code changed: "anchor.text" is what it was about. Answer in the note; don't change code unless a note asks you to.`
  if (list?.length) {
    const which = list.map((n) => `${dir}/${n.uri.path.split('/').pop()} (${n.data.file} ${lines(n)})`).join(', ')
    return `Answer ${list.length === 1 ? 'my code note' : `these ${list.length} code notes`}: ${which}. Read the code each one points at, then append your answer to "messages" with "role": "agent". ${rules}`
  }
  return `Answer my open code notes in ${dir}/: a note needs an answer when its status is "open" and its last message has "role": "human". Read the code each one points at, then append your answer to "messages" with "role": "agent". ${rules}`
}

export async function activate(context: vscode.ExtensionContext) {
  state = context.workspaceState
  for (const [k, v] of Object.entries(state.get<Record<string, string>>('codeNotes.askErrors') ?? {})) askErrors.set(k, v)
  // No claude CLI: no Ask Claude anywhere; the setting's description says how to get it.
  extVersion = String(context.extension.packageJSON?.version ?? extVersion)
  // In Restricted Mode `codeNotes.claude.path` comes from the user's settings only (package.json:
  // restrictedConfigurations), so a folder's own settings never pick the program run here.
  const probeClaude = () => setCtx('codeNotes.claudeFound', !!findCli(cfg().get<string>('claude.path') || undefined))
  probeClaude()
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('codeNotes.claude.path')) probeClaude() }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => probeClaude()), writingChanged)
  extUri = context.extensionUri
  groupMode = state.get<'file' | 'session'>(GROUP_KEY) === 'session' ? 'session' : 'file'
  log = vscode.window.createOutputChannel('Code Notes', { log: true })
  gitName = await detectGitName(vscode.workspace.workspaceFolders?.[0])
  store = new Store(log, me)
  controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Code Notes')
  // No commenting-range bar on every line (–): the whole file is commentable only while Add Note opens its
  // box (Ctrl+' C, the command); VS Code asks again when the provider is set.
  controller.commentingRangeProvider = rangeProvider
  controller.options = NOTE_OPTIONS
  tree = new NotesTree()
  treeView = vscode.window.createTreeView('codeNotes.notes', { treeDataProvider: tree, showCollapseAll: false, canSelectMany: true, manageCheckboxStateManually: true })
  const folded = (e: vscode.TreeViewExpansionEvent<Node>, st: vscode.TreeItemCollapsibleState) => { const id = tree.getTreeItem(e.element).id; if (id) tree.folded.set(id, st) }
  context.subscriptions.push(treeView.onDidExpandElement((e) => folded(e, vscode.TreeItemCollapsibleState.Expanded)), treeView.onDidCollapseElement((e) => folded(e, vscode.TreeItemCollapsibleState.Collapsed)))
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  moveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51)
  moveItem.command = 'codeNotes.completeMove'
  moveItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  tourItems = {
    prev: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.3),
    pos: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.2),
    next: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.1),
    end: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.0),
  }
  tourItems.end.text = '$(close)'
  tourItems.end.command = 'codeNotes.endJourney'
  tourItems.prev.text = '$(chevron-left)'
  tourItems.prev.command = 'codeNotes.previousStep'
  tourItems.pos.command = 'codeNotes.showMap'
  tourItems.next.text = '$(chevron-right)'
  tourItems.next.command = 'codeNotes.nextStep'
  journeys = new Journeys(log, context.workspaceState)
  devReload(context, log)
  beats = new Beats(log)
  tutorialSpot = new TutorialSpot()
  context.subscriptions.push(tutorialSpot)
  codeLinks = new CodeLinks(log)
  valueHints = new ValueHints(log, () => codeLinks.backAt, codeLinks.onDidChange)
  context.subscriptions.push(beats, codeLinks, valueHints, vscode.commands.registerCommand('codeNotes.codeLink', async (key: string, i: number) => {
    const lj = tourJourney()
    // A second click on the lit phrase turns it off; the step comes back if its card was out of sight.
    if (codeLinks.isLit(key, i)) { const away = codeLinks.state.back; codeLinks.unlight(); if (away && lj && tourStep) await goToStep(lj, tourStep); return }
    tourCursorUntil = Date.now() + 1500
    const card = lj && tourStep && !cardInMap(lj, tourStep) ? { uri: stepUri(lj, tourStep).toString(), line: cardLine(lj, tourStep) } : undefined
    // An icon and words, so it reads as a control and not as one more value.
    await codeLinks.open(key, i, codeColumn, tourStep ? `$(arrow-left) Back to step ${tourStep}` : '$(arrow-left) Back', card)
  }),
    vscode.commands.registerCommand('codeNotes.codeLinkBack', async () => { codeLinks.unlight(); const lj = tourJourney(); if (lj && tourStep) await goToStep(lj, tourStep) }))
  gstate = context.globalState
  KEY = gstate.get<string>(PREFIX_KEY) ?? KEY
  mapPanel = new MapPanel(context.extensionUri, log, onMapMessage, (lj) => ({
    key: KEY, tutorial: !gstate.get<boolean>(TUTORIAL_KEY),
    current: lj.key === tourKey ? tourStep : 0, marks: stepMarks(lj), resume: resumeAt(lj), legendHidden: state.get<boolean>('codeNotes.legendHidden') ?? true, // on demand (M99)
    ...(gstate.get<number>(MAP_WIDTH_KEY) ? { mapWidth: gstate.get<number>(MAP_WIDTH_KEY) } : {}),
    problems: lj.readError ? [lj.readError] : [], authors: cfg().get<boolean>('journeys.authorMode') ? lj.j.problems.length : 0, moved: Object.fromEntries(journeys.renames(lj)),
    ...(lj.key === tourKey && tourStep && cardInMap(lj, tourStep) ? { card: panelCard(lj, tourStep) } : {}),
    asked: askedOf(lj), prov: provenance(lj),
    list: journeyOrder().map((x) => ({ key: x.key, title: x.j.title, question: x.j.question, steps: x.j.steps.length, resume: resumeAt(x), ...(x.key === lj.key ? { here: true } : {}), ...(x.j.start ? { start: true } : {}) })),
    ...(finishedKey === lj.key && !(lj.key === tourKey && tourStep) ? { done: true } : {}),
  }), state)
  refDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center })
  context.subscriptions.push(refDeco, lensChanged, vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: STEP_SCHEME }], { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses: stepLenses }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(STEP_SCHEME, { provideTextDocumentContent: (uri) => stepPage(uri.query) }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, { provideTextDocumentContent: refCopy }))
  stepController = vscode.comments.createCommentController('codeNotes.journey', 'Journey')
  stepController.options = { prompt: '', placeHolder: '' }
  stepDeco = {
    at: vscode.window.createTextEditorDecorationType({
      // A faint tint too: clear which lines the step is about; selection and find stay on top.
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('textLink.foreground'),
      backgroundColor: new vscode.ThemeColor('codeNotes.stepBackground'),
      overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
    }),
    stale: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
    }),
  }
  // The map comes back after a reload: VS Code hands the old panel over once the journeys are read.
  let journeysLoaded!: () => void
  const journeysReady = new Promise<void>((r) => { journeysLoaded = r })
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(MAP_VIEW, {
    deserializeWebviewPanel: async (panel, st) => {
      mapPanel.placeholder(panel, st as { q?: string; cur?: number; n?: number } | undefined)
      await journeysReady
      const lj = journeys.byPos(state.get<string>(MAP_KEY))
      if (!lj) { panel.dispose(); return }
      if (!tourKey) tourKey = lj.key
      mapPanel.adopt(panel, lj)
      updateTour()
    },
  }))
  deco = {
    open: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.noteBackground'),
      borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
      overviewRulerColor: new vscode.ThemeColor('codeNotes.noteRuler'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    stale: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.staleBackground'),
      borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    openBar: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
      overviewRulerColor: new vscode.ThemeColor('codeNotes.noteRuler'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    staleBar: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    // Quieter than the note's tint: a light wash and a dotted line, never yellow (amber means stale).
    exact: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('codeNotes.selectionBackground'),
      borderWidth: '0 0 1px 0', borderStyle: 'dotted', borderColor: new vscode.ThemeColor('codeNotes.noteBorder'),
    }),
    unread: vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('codeNotes.unreadForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  }
  setCtx('codeNotes.showResolved', false)
  lastMe = me()
  context.subscriptions.push(log, store, controller, treeView, statusItem, moveItem, ...Object.values(deco), journeys, mapPanel, ...Object.values(tourItems),
    stepController, stepDeco.at, stepDeco.stale, { dispose: clearCard })
  context.subscriptions.push(journeys.onDidChange(() => {
    lensChanged.fire()
    for (const lj of journeys.list.values()) mapPanel.update(lj)
    refreshAll()
    // The journey file was rewritten: the same step (by id), with its new text.
    followStep()
  }), journeys.onDidMoveSteps((lj) => {
    lensChanged.fire()
    mapPanel.update()
    if (lj.key === tourKey && tourStep) showCard(lj, tourStep)
    refreshStepDecorations()
  }), vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) journeys.onDocument(e.document) }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ORPHAN_SCHEME, {
    provideTextDocumentContent: (uri) => { const n = byId(uri.query); return n ? orphanMarkdown(n) : 'This note no longer exists.' },
  }))
  // The page a folder note's thread is on: the folder and what is in it.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(FOLDER_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const rel = uri.path.replace(/^\//, '').replace(/ \(folder\)$/, '')
      const dir = vscode.Uri.joinPath(vscode.Uri.parse(uri.query), rel)
      let entries: [string, vscode.FileType][] = []
      try { entries = await vscode.workspace.fs.readDirectory(dir) } catch { return `${rel}/ (not found)\n` }
      entries.sort((a, b) => (b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) || a[0].localeCompare(b[0]))
      return `${rel}/\n${entries.map(([name, t]) => `  ${name}${t & vscode.FileType.Directory ? '/' : ''}`).join('\n')}\n`
    },
  }))
  // An agent deleted a note file (rm): its last version is restorable from.trash, without a toast.
  context.subscriptions.push(store.onDidDeleteOnDisk((n) => {
    offerUndo(`Note deleted on disk: "${plain(n.data.messages[0]?.body ?? '', 40)}"`, async () => { await store.restore(n); refreshAll() }, true)
  }))

  // Notes changed on disk (an agent replied, resolved, or added a note). Someone else's reply reopens a resolved note.
  let reanchorTimer: NodeJS.Timeout | undefined
  let loaded = false
  context.subscriptions.push(store.onDidChange(async () => {
    for (const n of notes()) {
      const prev = shape.get(n.data.id)
      const count = n.data.messages.length
      if (loaded && prev && prev.status === 'resolved' && n.data.status === 'resolved' && count > prev.count &&
          n.data.messages.slice(prev.count).some((m) => !mine(m))) {
        n.data.status = 'open'
        addEvent(n, 'reopened', lastMessage(n)?.author ?? 'someone', isAgent(lastMessage(n)!) ? 'agent' : undefined)
        log.appendLine(`note ${n.data.id}: reopened by a reply from ${lastMessage(n)?.author}`)
        await store.save(n)
      } else if (loaded && prev && prev.status !== n.data.status) {
        log.info(`note ${n.data.id}: ${n.data.status} on disk (by someone else)`)
        // Changed on disk without saying so in "events": record it, as theirs, so it shows as new. Not when the file
        // lost events (an older version restored: git checkout, undo), nor twice in a row for the same change.
        const evs = n.data.events ?? []
        const type = n.data.status === 'resolved' ? 'resolved' : 'reopened'
        if (evs.length === prev.events && evs[evs.length - 1]?.type !== type) {
          const by = [...n.data.messages].reverse().find((m) => !mine(m))
          addEvent(n, type, by?.author ?? 'someone', by && isAgent(by) ? 'agent' : undefined)
          await store.save(n)
        }
      }
      shape.set(n.data.id, shapeOf(n))
    }
    refreshAll()
    // A question on the current step was asked or answered: the card says so.
    const tj = touring() ? tourJourney() : undefined
    if (tj && !cardInMap(tj, tourStep)) showCard(tj, tourStep)
    clearTimeout(reanchorTimer)
    reanchorTimer = setTimeout(() => reanchorAll().then(refreshAll), 200)
  }))

  // Follow edits live; re-anchor (moved code, stale) shortly after typing stops. Saved to disk only with the file.
  const pending = new Map<string, NodeJS.Timeout>()
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const list = lineNotesFor(e.document.uri)
    if (!list.length || !e.contentChanges.length) return
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start))
    const before = new Map<string, Loc>()
    for (const n of list) {
      let loc = toLoc(n.data)
      before.set(n.data.id, loc)
      let swallowed = false
      for (const c of changes) {
        const edit = { startLine: c.range.start.line, startChar: c.range.start.character, endLine: c.range.end.line, endChar: c.range.end.character, newLines: (c.text.match(/\n/g) ?? []).length }
        if (swallows(loc, edit)) swallowed = true
        loc = shift(loc, edit)
      }
      // A replace of the whole note (a reload from disk, git stash/checkout): search for it rather than stretch it.
      if (swallowed) loc = before.get(n.data.id)!
      n.data.range = { start: loc.start + 1, end: loc.end + 1 }
    }
    for (const n of list) syncThread(n)
    refreshDecorations()
    const key = e.document.uri.toString()
    clearTimeout(pending.get(key))
    pending.set(key, setTimeout(async () => {
      pending.delete(key)
      const ls = linesOf(e.document)
      for (const n of lineNotesFor(e.document.uri)) reanchor(n, ls, toLoc(n.data), before.get(n.data.id)?.start)
      refreshAll()
      if (!e.document.isDirty) for (const n of lineNotesFor(e.document.uri)) await store.save(n)
    }, 400))
  }))
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const list = lineNotesFor(doc.uri)
    if (!list.length) return
    const ls = linesOf(doc)
    for (const n of list) { reanchor(n, ls); await store.save(n) }
    refreshAll()
  }))

  // Files changed, created, deleted or renamed outside the editor (an agent, git): re-anchor and follow moves.
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*')
  /** A journey step's code is in this file. */
  const stepIn = (u: vscode.Uri) => [...journeys.list.values()].some((lj) => lj.j.steps.some((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path === u.path))
  let diskTimer: NodeJS.Timeout | undefined
  const onDisk = (u: vscode.Uri, created = false) => {
    if (inNotesFolder(u) || u.path.includes('/.git/')) return
    if (created) recentCreates.push({ uri: u, at: Date.now() })
    else if (!notesFor(u).length && !notes().some((n) => n.data.target === 'folder' && u.path.startsWith(pathUri(n).path)) && !stepIn(u)) return
    clearTimeout(diskTimer)
    diskTimer = setTimeout(async () => { await reanchorAll(); await followMovedFiles(); await followJourneyFiles() }, 600)
  }
  fileWatcher.onDidChange((u) => onDisk(u))
  fileWatcher.onDidCreate((u) => onDisk(u, true))
  fileWatcher.onDidDelete((u) => onDisk(u))
  context.subscriptions.push(fileWatcher, vscode.workspace.onDidRenameFiles(async (e) => {
    for (const { oldUri, newUri } of e.files) {
      for (const n of notes()) {
        const old = pathUri(n).path
        if (old === oldUri.path || old.startsWith(oldUri.path + '/')) {
          const folder = vscode.workspace.getWorkspaceFolder(newUri)
          if (!folder) continue
          n.data.file = relPath(folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length)))
          missing.delete(n.data.id)
          await store.save(n)
        }
      }
      // Journey steps follow renames too, in memory.
      for (const lj of journeys.list.values()) for (const s of lj.j.steps) {
        const old = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path
        if (old === oldUri.path || old.startsWith(oldUri.path + '/')) await journeys.moveStep(lj, s.n, relPath(lj.folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length))))
      }
    }
    refreshAll()
  }))

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => { noteVisibleEditors(); refreshDecorations(); restoreStepCard() }),
    vscode.window.tabGroups.onDidChangeTabs((e) => { for (const t of e.opened) void keepOffMap(t) }),
    vscode.window.onDidChangeActiveTextEditor(updateCursorContext),
    // The cursor on a note counts as reading it only when it is the one note on that line.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      updateCursorContext()
      const line = (e.selections[0]?.active.line ?? -2) + 1
      const here = notesFor(e.textEditor.document.uri).filter((n) => line >= n.data.range.start && line <= n.data.range.end)
      // Not when a journey step put the cursor there: arriving is not reading.
      if (Date.now() < tourCursorUntil) return
      if (here.length === 1 && unread(here[0]) && threads.has(here[0].data.id)) markRead(here, here[0])
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('codeNotes.folder')) { await changeFolder(); return }
      if (e.affectsConfiguration('codeNotes.journeys.folder')) { await journeys.load(); refreshAll() }
      if (e.affectsConfiguration('codeNotes.ignoreInGit')) await applyIgnoreInGit()
      else if (e.affectsConfiguration('codeNotes.author')) {
        // Messages under the old name stay yours.
        if (lastMe && lastMe !== me() && !pastNames().includes(lastMe)) await state.update(PAST_KEY, [...pastNames(), lastMe])
        lastMe = me()
        for (const f of vscode.workspace.workspaceFolders ?? []) if (notes().some((n) => n.folder === f)) await store.writeReadme(f)
        refreshAll()
      } else if (e.affectsConfiguration('codeNotes')) { lensChanged.fire(); refreshAll() }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void store.load(); void journeys.load() }),
    treeView.onDidChangeSelection((e) => {
      checked.clear()
      const sel = e.selection.filter((x) => x.kind === 'note')
      if (sel.length > 1) for (const x of sel) checked.add((x as { note: Note }).note.data.id)
      setCtx('codeNotes.hasChecked', checked.size > 0)
    }),
  )

  const cmd = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  /** A chord key passes which prefix was pressed: hints then show that one. */
  const prefixUsed = (a: unknown) => {
    const p = a && typeof a === 'object' ? (a as { prefix?: string }).prefix : undefined
    if (p !== "'" && p !== '<') return
    const k = `Ctrl+${p}`
    if (k === KEY) return
    KEY = k
    void gstate.update(PREFIX_KEY, k)
    updateTour()
    mapPanel.update()
  }
  cmd('codeNotes.add', (a?: unknown) => { prefixUsed(a); return addNote() })
  cmd('codeNotes.toggleAnimation', (a?: unknown) => { prefixUsed(a); toggleAnimation() })
  cmd('codeNotes.addQuick', addQuickNote)
  const noteFromNewThread = async (reply: vscode.CommentReply): Promise<Note | undefined> => {
    const t = reply.thread
    const body = reply.text.trim()
    if (!body) { t.dispose(); vscode.window.setStatusBarMessage('$(info) Empty note: not saved', 3000); return undefined } // no empty shell
    const doc = await vscode.workspace.openTextDocument(t.uri)
    const r = t.range ?? new vscode.Range(0, 0, 0, 0)
    // From "Ask about this step": the note says which step it is about.
    const ask = stepAsks.get(t)
    stepAsks.delete(t)
    t.dispose()
    return createNote(doc, rangeLines(doc, r), ask ? `${body}\n\n${ask.about}` : body, ask ? undefined : partialSelection(doc, r), ask ? { journey: ask.link } : undefined)
  }
  // A question from a step: one button, "Ask"; Claude answers when it is set up, else the agent reads the note.
  cmd('codeNotes.askFromThread', async (reply: vscode.CommentReply) => {
    const n = await noteFromNewThread(reply)
    if (n && claudeMode() !== 'off' && findCli(cfg().get<string>('claude.path') || undefined)) await askClaude(n)
  })
  cmd('codeNotes.createFromThread', async (reply: vscode.CommentReply) => {
    const n = await noteFromNewThread(reply)
    if (n && claudeMode() === 'always') await askClaude(n)
  })
  // Ask Claude: from the note box (a new note), a thread's reply box (a follow-up), a row, a link, or the cursor.
  cmd('codeNotes.askClaude', async (arg?: any, many?: any[]) => {
    if (arg && typeof arg === 'object' && 'thread' in arg && 'text' in arg) {
      const reply = arg as vscode.CommentReply
      const existing = noteOfThread(reply.thread)
      if (!existing) { const n = await noteFromNewThread(reply); if (n) await askClaude(n); return }
      if (reply.text.trim() && !(await addReply(existing, reply.text.trim()))) return
      await askClaude(existing)
      return
    }
    const list = typeof arg === 'string' ? [byId(arg)].filter((n): n is Note => !!n) : notesFrom(arg, many)
    for (const n of list) await askClaude(n)
  })
  cmd('codeNotes.cancelClaude', (arg?: any) => {
    const ids = typeof arg === 'string' ? [arg] : notesFrom(arg).map((n) => n.data.id)
    for (const id of ids) cancelAsk(id)
  })
  /** Adds your message; on a failed save (an error toast is shown) the note is left as it was. */
  const addReply = async (n: Note, text: string, status?: 'open' | 'resolved'): Promise<boolean> => {
    const before = { messages: n.data.messages.length, status: n.data.status, events: n.data.events }
    if (text) n.data.messages.push({ author: me(), role: 'human', body: text, at: now() })
    const next = status ?? (n.data.status === 'resolved' && text ? 'open' : n.data.status)
    if (next !== n.data.status) addEvent(n, next === 'resolved' ? 'resolved' : 'reopened')
    n.data.status = next
    if (!(await store.save(n))) {
      n.data.messages.length = before.messages
      n.data.status = before.status
      if (before.events) n.data.events = before.events; else delete n.data.events
      refreshAll()
      return false
    }
    shape.set(n.data.id, shapeOf(n))
    await markRead([n])
    return true
  }
  const reply = async (r: vscode.CommentReply) => {
    const n = noteOfThread(r.thread)
    if (!n || !r.text.trim()) return
    if ((await addReply(n, r.text.trim())) && claudeMode() === 'always') await askClaude(n)
  }
  cmd('codeNotes.reply', reply)
  cmd('codeNotes.replyReopen', reply) // the same, labelled for resolved threads
  // Answer and close in one step (the usual end of a thread).
  cmd('codeNotes.replyResolve', async (reply: vscode.CommentReply) => {
    const n = noteOfThread(reply.thread)
    if (!n) return
    if (!(await addReply(n, reply.text.trim(), 'resolved'))) return
    if (revealedId === n.data.id) revealedId = undefined
    refreshAll()
    offerUndo(`Resolved "${plain(n.data.messages[0]?.body ?? '', 40)}"`, () => setStatus([undoResolveEvent(n)], 'open', false))
  })
  const sessionArg = async (node?: Node): Promise<string | undefined> => {
    if (node?.kind === 'session') return node.name
    const names = [...new Set(notes().map(sessionOf))]
    if (names.length <= 1) return names[0]
    const pick = await vscode.window.showQuickPick(names.map((n) => ({ label: n || 'Notes', name: n, description: `${notes().filter((x) => sessionOf(x) === n).length} notes` })), { title: 'Which session?' })
    return pick?.name
  }
  cmd('codeNotes.hideSession', async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], true) })
  cmd('codeNotes.showSession', async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], false) })
  cmd('codeNotes.showOnlySession', async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], false, true) })
  cmd('codeNotes.showAllSessions', async () => { await state.update(HIDDEN_KEY, []); refreshAll() })
  cmd('codeNotes.resolveSession', async (node?: Node) => {
    const x = await sessionArg(node)
    if (x === undefined) return
    await resolve(notes().filter((n) => sessionOf(n) === x && n.data.status === 'open'), x ? ` in "${x}"` : '')
    // "Show only" this session, and it is done: show the others again.
    const h = hiddenSessions()
    const rest = new Set(notes().filter((n) => n.data.status === 'open').map(sessionOf))
    if (!rest.has(x) && rest.size && [...rest].every((s) => h.has(s))) {
      await state.update(HIDDEN_KEY, [])
      refreshAll()
      vscode.window.setStatusBarMessage('$(eye) Showing all sessions again', 3000)
    }
  })
  cmd('codeNotes.deleteSession', async (node?: Node) => {
    const x = await sessionArg(node)
    if (x === undefined) return
    const list = notes().filter((n) => sessionOf(n) === x)
    const ok = await vscode.window.showWarningMessage(`Delete the session "${x || 'Notes'}" (${list.length} notes)?`, { modal: true, detail: `They move to ${folderName()}/.trash and can be restored with Undo.` }, 'Delete')
    if (ok === 'Delete') await trash(list, `the session "${x || 'Notes'}"`)
  })
  cmd('codeNotes.openAt', async (folderUri: string, file: string, line: number, end?: number, step?: number) => {
    const lj = tourJourney()
    if (step && lj && touring() && lj.folder.uri.toString() === folderUri) return openRef(lj, file, line, end ?? line, step)
    const uri = vscode.Uri.joinPath(vscode.Uri.parse(folderUri), file)
    try { await vscode.workspace.fs.stat(uri) } catch { void showError(`Code Notes: ${file} doesn't exist in this folder.`); return }
    const ed = await vscode.window.showTextDocument(uri, { preview: true })
    const pos = new vscode.Position(Math.max(0, Math.min(line - 1, ed.document.lineCount - 1)), 0)
    ed.selection = new vscode.Selection(pos, pos)
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  })
  cmd('codeNotes.expandThread', (id: string) => { expanded.add(id); const n = byId(id); if (n) syncThread(n) })
  cmd('codeNotes.collapseThread', (id: string) => { expanded.delete(id); const n = byId(id); if (n) syncThread(n) })
  cmd('codeNotes.undo', () => (lastUndo ? undoLast() : vscode.window.setStatusBarMessage('$(info) Nothing to undo', 2500)))
  // A broken note file: open it at the field that is wrong.
  cmd('codeNotes.openBroken', async (node?: Node) => {
    if (node?.kind !== 'broken') return
    const uri = vscode.Uri.parse(node.uri)
    const doc = await vscode.workspace.openTextDocument(uri)
    const field = /"(range|status|messages|file)/.exec(node.why)?.[1] ?? (/^message \d/.test(node.why) ? 'messages' : undefined)
    const at = field ? doc.getText().indexOf(`"${field}"`) : node.why.startsWith('not valid JSON') ? doc.getText().length : -1
    const pos = at >= 0 ? doc.positionAt(at) : new vscode.Position(0, 0)
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
    vscode.window.setStatusBarMessage(`$(warning) ${node.why}`, 6000)
  })
  cmd('codeNotes.restoreBroken', async (node?: Node) => {
    if (node?.kind !== 'broken') return
    const known = store.notes.get(node.uri)
    if (!known) return
    await vscode.workspace.fs.writeFile(known.uri, new TextEncoder().encode(serialize(known.data)))
    vscode.window.setStatusBarMessage('$(check) Restored the last good version', 3000)
  })
  cmd('codeNotes.markUnread', async (arg?: any) => {
    const [n] = notesFrom(arg)
    if (!n) return
    let i = n.data.messages.length - 1
    while (i >= 0 && mine(n.data.messages[i])) i--
    if (i < 0) { vscode.window.setStatusBarMessage('$(info) Nothing to mark unread: every message is yours', 2500); return }
    visitFrom.delete(n.data.id)
    if (revealedId === n.data.id) revealedId = undefined
    await setSeen([[n.data.id, i]])
    refreshAll()
  })
  cmd('codeNotes.reveal', (node?: Node) => { const [n] = notesFrom(node); if (n) return reveal(n) })
  cmd('codeNotes.resolve', async (arg?: any, many?: any[]) => resolve(await target(arg, many)))
  cmd('codeNotes.reopen', async (arg?: any, many?: any[]) => {
    const list = await target(arg, many)
    if (!list.length) return
    await setStatus(list, 'open')
    vscode.window.setStatusBarMessage(`$(issue-reopened) Reopened ${list.length === 1 ? `"${plain(list[0].data.messages[0]?.body ?? '', 40)}"` : `${list.length} notes`}`, 3000)
  })
  cmd('codeNotes.delete', async (arg?: any, many?: any[]) => {
    const list = await target(arg, many)
    if (list.length) return trash(list, list.length === 1 ? `"${plain(list[0].data.messages[0]?.body ?? '', 40)}"` : `${list.length} notes`)
  })
  cmd('codeNotes.acceptCode', async (arg?: any) => {
    const [n] = notesFrom(arg)
    if (!n || missing.has(n.data.id)) return
    const doc = await vscode.workspace.openTextDocument(docUri(n))
    const loc = toLoc(n.data)
    const end = Math.min(loc.end, doc.lineCount - 1)
    // Kept here on this branch; an exact text that is gone is dropped.
    n.data.anchor = { ...captureAnchor(linesOf(doc), Math.min(loc.start, end), end), ...(await commitInfo(n.folder)) }
    if (n.data.selection && !n.data.anchor.text.includes(n.data.selection.text)) delete n.data.selection
    n.data.stale = false
    pastEnd.delete(n.data.id)
    await saveIfClean(n)
    refreshAll()
  })
  cmd('codeNotes.moveToSelection', (arg?: any) => {
    const [n] = notesFrom(arg)
    if (!n) return
    const e = vscode.window.activeTextEditor
    const own = e && docUri(n).toString() === e.document.uri.toString() && !e.selection.isEmpty
      && e.selection.start.line + 1 >= n.data.range.start && e.selection.end.line + 1 <= n.data.range.end
    // A selection elsewhere: move there now (with Undo). Otherwise ask for one.
    if (e && !e.selection.isEmpty && !own) { pendingMove = n.data.id; return completeMove() }
    return startMove(n)
  })
  cmd('codeNotes.completeMove', completeMove)
  cmd('codeNotes.cancelMove', cancelMove)
  cmd('codeNotes.openNoteFile', (arg?: any) => { const [n] = notesFrom(arg); if (n) return vscode.window.showTextDocument(n.uri) })
  cmd('codeNotes.resolveChecked', () => {
    const sel = treeView.selection.filter((x) => x.kind === 'note').map((x) => (x as { note: Note }).note)
    const list = checked.size ? [...checked].map(byId).filter((n): n is Note => !!n && matchesFilter(n)) : sel
    if (!list.length) { vscode.window.setStatusBarMessage('$(info) Select the notes to resolve (Ctrl+click for several)', 2500); return }
    return resolve(list)
  })
  cmd('codeNotes.resolveAll', async () => {
    const open = notes().filter((n) => n.data.status === 'open')
    if (!open.length) return
    const u = open.filter((n) => unread(n) > 0).length
    const ok = await vscode.window.showWarningMessage(`${open.length === 1 ? 'Resolve 1 note?' : `Resolve all ${open.length} notes?`}${u ? ` ${u} ${u === 1 ? 'has' : 'have'} replies you haven't read.` : ''} Journeys stay.`, { modal: true }, 'Resolve All')
    if (ok === 'Resolve All') { await markRead(open); await setStatus(open, 'resolved') }
  })
  cmd('codeNotes.deleteResolved', async () => {
    const done = notes().filter((n) => n.data.status === 'resolved')
    if (!done.length) { vscode.window.setStatusBarMessage('$(info) No resolved notes', 2500); return }
    const u = done.filter((n) => unread(n) > 0).length
    const ok = await vscode.window.showWarningMessage(`Purge ${done.length} resolved note${done.length === 1 ? '' : 's'}?`, {
      modal: true, detail: `${u ? `${u} unread. ` : ''}They go to ${folderName()}/.trash; Undo brings them back.`,
    }, 'Purge')
    if (ok === 'Purge') await trash(done, `${done.length} resolved note${done.length === 1 ? '' : 's'}`)
  })
  cmd('codeNotes.markAllRead', async () => {
    const list = notes().filter((n) => unread(n) > 0)
    if (!list.length) return
    const before = { ...seenMap() }
    await markRead(list)
    offerUndo(`Marked ${list.length} note${list.length === 1 ? '' : 's'} read`, async () => { await state.update(SEEN_KEY, before); refreshAll() })
  })
  // Open Journey…: always the picker; from a sidebar row, that journey.
  // From a sidebar row (an argument): the focus stays in the list, so arrows and Enter never type into the code.
  cmd('codeNotes.openJourney', async (arg?: unknown) => { const lj = await pickJourney(arg); if (lj) await walkJourney(lj, arg !== undefined ? { keepFocus: 'sidebar' } : {}) })
  // Show Map (the V chord): the tour's or the last journey's map; the picker when there is none.
  cmd('codeNotes.showMap', async (a?: unknown) => {
    prefixUsed(a)
    const lj = tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? (await pickJourney())
    if (lj) await openMap(lj)
    // "The map" means the map: an animation showing in its place goes.
    mapPanel.send({ type: 'anim', action: 'off' })
  })
  cmd('codeNotes.startJourney', async (arg?: unknown) => { const lj = await pickJourney(arg ?? tourKey); if (lj) await goToStep(lj, 1) })
  cmd('codeNotes.nextStep', () => stepBy(1))
  cmd('codeNotes.previousStep', () => stepBy(-1))
  cmd('codeNotes.endJourney', endTour)
  // A note asked from a step: back to that step.
  cmd('codeNotes.openStepLink', async (id: string, stepId: string, n: number) => {
    const lj = [...journeys.list.values()].find((x) => x.j.id === id)
    if (!lj) { vscode.window.setStatusBarMessage('$(info) That journey is gone', 3000); return }
    const i = lj.j.steps.findIndex((x) => x.id === stepId)
    await openMap(lj)
    await goToStep(lj, i >= 0 ? i + 1 : n)
  })
  // From a reference's "← Back to step n" (R8).
  // the setting is the state (journeys.authorMode); the command (shown only while it is on) turns it off.
  cmd('codeNotes.toggleAuthorMode', async () => {
    await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Global)
    if (cfg().inspect('journeys.authorMode')?.workspaceValue) await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Workspace)
    vscode.window.setStatusBarMessage('$(info) Journey author mode off', 2500)
    mapPanel.update()
  })
  // "Ask a Question About the Code…": a request with a question, from the palette: the journey that answers it, else one
  // written for it.
  cmd('codeNotes.askQuestion', async () => {
    const q = (await vscode.window.showInputBox({ prompt: 'Ask a question about the code', placeHolder: 'How does … work?', ignoreFocusOut: true }))?.trim()
    if (!q) return
    // The same path as a request with a question (matching, a pick of close matches, trust, model check, the confirm).
    return handleExplain({ action: 'ask', question: q }, 'command')
  })
  cmd('codeNotes.backToStep', async () => { const lj = tourJourney(); if (lj && tourStep) await goToStep(lj, tourStep) })
  cmd('codeNotes.askStep', (text?: string) => askStep(text))
  cmd('codeNotes.askStepUpdate', () => askUpdate())
  cmd('codeNotes.openNoteId', (id: string) => { const nt = byId(id); if (nt) return reveal(nt) })
  cmd('codeNotes.tutorial', tutorial)
  cmd('codeNotes.stepDetails', (open?: boolean) => {
    stepDetailsOpen = open ?? !stepDetailsOpen
    const lj = tourJourney()
    if (lj && tourStep) showCard(lj, tourStep)
  })
  cmd('codeNotes.nextUnread', () => stepUnread(1))
  cmd('codeNotes.previousUnread', () => stepUnread(-1))
  cmd('codeNotes.showResolved', () => { showResolved = true; setCtx('codeNotes.showResolved', true); refreshAll() })
  cmd('codeNotes.hideResolved', () => { showResolved = false; setCtx('codeNotes.showResolved', false); refreshAll() })
  cmd('codeNotes.filter', async () => {
    const pick = await vscode.window.showQuickPick(FILTERS.map((f) => ({
      label: `${f.id === filter ? '$(check) ' : ''}${f.label}`, detail: f.detail, id: f.id,
      description: `${notes().filter((n) => { const keep = filter; filter = f.id; const r = matchesFilter(n); filter = keep; return r }).length}`,
    })), { title: 'Show in Code Notes' })
    if (!pick) return
    filter = pick.id
    for (const id of [...checked]) { const n = byId(id); if (!n || !matchesFilter(n)) checked.delete(id) } // no invisible ticks
    refreshAll()
  })
  cmd('codeNotes.filterActive', () => vscode.commands.executeCommand('codeNotes.filter'))
  // Every word must match somewhere in the note: messages as written, file, session, authors.
  cmd('codeNotes.find', async () => {
    const all = notes().sort((a, b) => a.data.file.localeCompare(b.data.file) || order(a, b))
    const hay = new Map(all.map((n) => [n.data.id, [n.data.file, n.data.session ?? '', ...n.data.messages.flatMap((m) => [m.author, m.body])].join('\n').toLowerCase()]))
    const item = (n: Note, words: string[]) => {
      const hit = words.length ? [...n.data.messages].reverse().find((m) => words.some((w) => m.body.toLowerCase().includes(w))) : undefined
      const shown = hit && hit !== n.data.messages[0] ? hit : n.data.messages.length > 1 ? lastMessage(n) : undefined
      return {
        label: `${unread(n) ? '$(circle-filled) ' : n.data.stale ? '$(warning) ' : n.data.status === 'resolved' ? '$(pass) ' : ''}${plain(n.data.messages[0]?.body ?? '', 70)}`,
        description: [`${n.data.file.split('/').pop()}:${n.data.range.start}`, n.data.session ? plain(n.data.session, 30) : ''].filter(Boolean).join(' · '),
        detail: shown ? `${shown.author}: ${plain(shown.body, 100)}` : undefined,
        alwaysShow: true, // filtered here, not by VS Code
        note: n,
      }
    }
    const qp = vscode.window.createQuickPick<ReturnType<typeof item>>()
    qp.title = 'Find a note'
    qp.placeholder = 'Words in notes, replies, files or sessions'
    const update = () => {
      const words = qp.value.toLowerCase().split(/\s+/).filter(Boolean)
      qp.items = all.filter((n) => words.every((w) => hay.get(n.data.id)!.includes(w))).map((n) => item(n, words))
    }
    qp.onDidChangeValue(update)
    update()
    qp.onDidAccept(() => { const pick = qp.selectedItems[0]; qp.hide(); if (pick) void reveal(pick.note) })
    qp.onDidHide(() => qp.dispose())
    qp.show()
  })
  cmd('codeNotes.refresh', async () => { await store.load(); await journeys.load() })
  // The toast says what is in the clipboard: the ticked notes, or the waiting ones.
  cmd('codeNotes.copyAgentPrompt', async () => {
    const waiting = notes().filter((n) => n.data.status === 'open' && lastMessage(n) && mine(lastMessage(n)!)).length
    const ticked = [...checked].map(byId).filter((n): n is Note => !!n)
    if (!ticked.length && !waiting) { vscode.window.showInformationMessage('No notes are waiting for an agent. Select notes (Ctrl+click) to ask about them.'); return }
    await vscode.env.clipboard.writeText(agentPrompt(ticked.length ? ticked : undefined))
    log.info(`copied a prompt for ${ticked.length ? ticked.map((n) => n.data.id).join(', ') : `the ${waiting} waiting notes`}`)
    const k = ticked.length || waiting
    vscode.window.showInformationMessage(`Copied a prompt for ${k} ${ticked.length ? 'selected' : 'waiting'} note${k === 1 ? '' : 's'}.`)
  })
  cmd('codeNotes.copyNotePrompt', async (arg?: any) => {
    const [n] = notesFrom(arg)
    if (!n) return
    await vscode.env.clipboard.writeText(agentPrompt([n]))
    vscode.window.showInformationMessage('Copied a prompt for this note.')
  })
  // The chord keys (Ctrl+' or Ctrl+< then C/R/D/A/V). D/A: the steps while a tour runs, else unread notes only.
  cmd('codeNotes.next', (a?: unknown) => {
    prefixUsed(a)
    if (touring()) return stepBy(1)
    // No tour: D is the next unread reply, as the status bar says; resuming is the map's ▶ Resume.
    return stepUnread(1)
  })
  cmd('codeNotes.previous', (a?: unknown) => { prefixUsed(a); return touring() ? stepBy(-1) : stepUnread(-1) })
  // R: resolve the note at the cursor, then on to the next unread one.
  cmd('codeNotes.resolveNext', async (a?: unknown) => {
    prefixUsed(a)
    const list = await target(undefined)
    if (!list.length) return
    await resolve(list)
    if (notes().some((n) => unread(n) > 0)) await stepUnread(1)
  })
  cmd('codeNotes.groupByFile', async () => { groupMode = 'file'; await state.update(GROUP_KEY, 'file'); refreshAll() })
  cmd('codeNotes.groupBySession', async () => { groupMode = 'session'; await state.update(GROUP_KEY, 'session'); refreshAll() })
  cmd('codeNotes.addPathNote', (uri?: vscode.Uri, text?: string) => addPathNote(uri, text))
  cmd('codeNotes.applySuggestion', (id: string, mi: number, k: number) => applySuggestion(id, mi, k))

  for (const f of vscode.workspace.workspaceFolders ?? []) {
    await refreshBranch(f)
    const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.git/HEAD'))
    const onHead = () => { return refreshBranch(f).then(refreshAll) }
    head.onDidChange(onHead); head.onDidCreate(onHead)
    context.subscriptions.push(head)
  }
  currentFolder = folderName()
  await store.load()
  await journeys.load()
  await markJourneysSeen()
  journeysLoaded()
  await migrateSeen()
  for (const n of notes()) shape.set(n.data.id, shapeOf(n))
  loaded = true
  refreshAll()
  await restoreTour()
  // Requests from scripts: the link, and the request file (one that came before this window did is handled now).
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (u) => void onUri(u).catch((e) => log.error(`explain link: ${e}`)) }))
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, REQUEST_FILE))
    const take = () => void consumeRequest(f).catch((e) => log.error(`explain request: ${e}`))
    w.onDidCreate(take); w.onDidChange(take)
    context.subscriptions.push(w)
    take()
  }
  // For the integration test (test/integration): a read-only view of what the extension shows.
  return {
    snapshot: () => ({
      notes: notes().sort(order).map((n) => ({ ...n.data, path: n.uri.path, unread: unread(n), missing: missing.has(n.data.id), threadLabel: threads.get(n.data.id)?.label, hasThread: threads.has(n.data.id), threadExpanded: threads.get(n.data.id)?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded, asking: asking.has(n.data.id), askError: askErrors.get(n.data.id) })),
      broken: store.broken.size,
      badge: treeView.badge?.value ?? 0,
      me: me(),
      journeys: journeys.all().map((x) => ({ id: x.j.id, steps: x.j.steps.length, at: x.at, resume: resumeAt(x) })),
      tour: {
        journey: tourJourney()?.j.id, step: tourStep, touring: touring(), map: mapPanel.journey?.j.id, mapTitle: mapPanel.tabTitle, mapBoxes: mapPanel.rendered, mapFocus: mapPanel.focus,
        beat: beats.lit, beatCode: beats.preview, codeLinks: codeLinks.state, values: valueHints.state, mapColumn: mapPanel.viewColumn, codeColumn: tourDoc?.column, status: tourItems.pos.text, statusShown: !!tourItems.pos.text && touring(),
        tutorial: { ...tutorialSeen, seen: !!gstate.get(TUTORIAL_KEY), spot: tutorialSpot.shown, mark: tutorialMark }, key: KEY, lastLeft, fileGone: stepFileGone,
        panelCard: touring() && cardInMap(tourJourney()!, tourStep) ? panelCard(tourJourney()!, tourStep) : undefined, ref: refHere, peek: lastPeek, marked: stepMarked,
        card: stepThread ? { file: stepThread.uri.path, line: stepThread.range?.start.line, label: stepThread.label, title: stepThread.label?.replace(/^\d+\/\d+ · /, ''),
          body: (stepThread.comments[0]?.body as vscode.MarkdownString | undefined)?.value, canReply: stepThread.canReply, expanded: stepThread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded } : undefined,
      },
      /** The sidebar's children of a session, as note ids. */
      /** The sidebar as text: one line per row, indented by depth (label · description · icon). */
      tree: () => {
        const out: string[] = []
        const walk = (nodes: Node[], depth: number) => {
          for (const x of nodes) {
            const it = tree.getTreeItem(x)
            const label = typeof it.label === 'string' ? it.label : it.label?.label
            const folded = x.kind === 'journeys' && it.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed ? ' {collapsed}' : ''
            out.push(`${'  '.repeat(depth)}${x.kind}:${label}${it.description ? ` · ${it.description}` : ''}${it.iconPath instanceof vscode.ThemeIcon ? ` [${it.iconPath.id}]` : ''}${folded}`)
            walk(tree.getChildren(x), depth + 1)
          }
        }
        walk(tree.getChildren(), 0)
        return out
      },
      groupBy: groupMode,
      sessionOrder: (name: string) => tree.getChildren(cached(`session:${name}`, { kind: 'session', name, notes: notes().filter((x) => sessionOf(x) === name && matchesFilter(x)) }))
        .map((x) => (x.kind === 'note' ? x.note.data.id : x.kind)),
    }),
    thread: (id: string) => threads.get(id),
    /** Forgets the tour in memory and restores it from workspace state, as after a window reload. */
    /** Sends a message into the map webview (tests drive its real click/key handlers this way). */
    mapSend: (m: unknown) => mapPanel.send(m),
    resetTutorial: async () => { await gstate.update(TUTORIAL_KEY, undefined); Object.assign(tutorialSeen, { bar: 0, card: 0, done: 0, skip: 0, inside: 0 }) },
    reloadTour: async () => {
      clearCard(); tourKey = undefined; tourStep = 0; tourDoc = undefined; updateTour()
      await restoreTour()
    },
    applySuggestion,
    /** the picker's "Ask the agent to write a journey" item, without the picker. */
    writeJourney: (q: string) => writeJourney(q).then((x) => x?.j.id),
    /** Journeys being written now: the rows a list shows. */
    writing: () => writingRows(),
    /** The pending "Write one with Claude?": its title and items; answer it by item label ('$(sparkle) Write', 'Cancel', a journey's). */
    confirming: () => confirming && { title: confirming.qp.title, question: confirming.question, items: confirming.qp.items.filter((x) => x.kind !== vscode.QuickPickItemKind.Separator).map((x) => x.label) },
    answerConfirm: (label: string) => { const c = confirming; const it = c?.qp.items.find((x) => x.label === label || x.label.endsWith(` ${label}`)); if (c && it) c.accept(it); return !!it },
    /** Claude's question before writing, and answering it. */
    clarify: () => clarify && { question: clarify.question, session: clarify.session, text: clarify.text },
    answerClarify: (text: string) => answerClarify(text).then((x) => x?.j.id),
    /** The open Ask box on a step: type into it and press Enter. */
    askBox: () => stepAskBox && { title: stepAskBox.box.title, value: stepAskBox.box.value },
    askBoxSend: (text: string) => { const b = stepAskBox; if (!b) return false; b.box.value = text; askDrafts.set(`${tourJourney()?.j.id}|${tourJourney()?.j.steps[tourStep - 1]?.id}`, text); b.accept(); return true },
    /** The pick: its journeys' titles, and choosing one. */
    choosing: () => choosing?.titles,
    choose: (title: string) => choosing?.accept(title),
    /** What each request did. */
    explainLog: () => explainLog.map((x) => ({ ...x })),
    /** Reads every journey file again, as after a window reload. */
    reloadJourneys: () => journeys.load(),
  }
}

export function deactivate(): void { /* disposables clean up */ }
