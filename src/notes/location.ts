// Where a note is: its file (or folder) on disk, and its lines followed as the code moves (anchor.ts finds them); with
// the small helpers about workspace paths and a document's lines that go with that.

import * as vscode from 'vscode'
import { anchor, Loc } from '../anchor'
import { log, notes, store } from '../app'
import { commitInfo, otherBranch } from '../identity'
import { refreshAll } from '../refresh'
import { captureAnchor, NoteData } from '../noteModel'
import { folderName, Note } from '../store'
import { diskLines, docLines, wfs } from '../wfs'
import { folderPage } from './pages'

type Anchor = NoteData['anchor']

/** Notes whose code file does not exist (deleted or moved). */
export const missing = new Set<string>()

/** Notes whose range starts past the end of their file: note id -> the file's line count. */
export const pastEnd = new Map<string, number>()

/** The note's code is where it says again: not stale, not missing, not past the end of its file. */
export function markPlaced(n: Note): void {
  n.data.stale = false
  missing.delete(n.data.id)
  pastEnd.delete(n.data.id)
}

/** The file or folder the note is about, on disk. */
export function pathUri(n: Note): vscode.Uri { return vscode.Uri.joinPath(n.folder.uri, n.data.file) }

/** The document the note's thread is on. */
export function docUri(n: Note): vscode.Uri { return n.data.target === 'folder' ? folderPage(n.folder, n.data.file) : pathUri(n) }

/** Notes on lines (not a whole file or folder) of this document: the ones that follow edits. */
export const lineNotesFor = (uri: vscode.Uri) => notesFor(uri).filter((n) => !n.data.target)

export function relPath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const base = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/'
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : vscode.workspace.asRelativePath(uri, false)
}

export function notesFor(uri: vscode.Uri): Note[] {
  return notes().filter((n) => docUri(n).toString() === uri.toString())
}

/** Notes of this document covering 1-based line `line`. */
export function notesAtLine(uri: vscode.Uri, line: number): Note[] {
  return notesFor(uri).filter((n) => line >= n.data.range.start && line <= n.data.range.end)
}

export function openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
}

/** A file's lines: an editor's with unsaved changes (they are the truth), else the disk's (VS Code keeps closed or
 *  deleted files' documents around). */
export async function linesOfUri(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = openDoc(uri)
  if (open && !open.isClosed && open.isDirty) return docLines(open)
  return diskLines(uri)
}

/** 1-based lines `line`..`end` as 0-based lines that exist in the document (`end` never before `start`). */
export function clampLines(doc: { lineCount: number }, line: number, end: number): { start: number; end: number } {
  const last = doc.lineCount - 1
  const start = Math.max(0, Math.min(line - 1, last))
  return { start, end: Math.max(start, Math.min(end - 1, last)) }
}

/** 0-based lines cut to a file of `lineCount` lines: the end at most its last line, the start at most the end. */
export function withinLines(loc: Loc, lineCount: number): Loc {
  const end = Math.min(loc.end, lineCount - 1)
  return { start: Math.min(loc.start, end), end }
}

export const toLoc = (d: NoteData): Loc => ({ start: d.range.start - 1, end: d.range.end - 1 })

/** A new anchor on 0-based lines `start`..`end`: their text and the lines around them, with the commit and branch. */
export async function anchorAt(lines: string[], start: number, end: number, folder: vscode.WorkspaceFolder): Promise<Anchor> {
  return { ...captureAnchor(lines, start, end), ...(await commitInfo(folder)) }
}

/** Never anchored: an agent wrote the note without one (empty, not even blank lines). */
export const noAnchor = (a: Anchor) => !a.text && !a.before && !a.after

/** Nothing to recognise the code by: no anchor, or only blank lines (any file would "match" it). */
export const blankAnchor = (a: Anchor) => !a.text.trim() && !a.before.trim() && !a.after.trim()

/** Where anchor `a` is in `lines` now (anchor.ts), near `tracked`. */
const find = (lines: string[], a: Anchor, tracked: Loc, hint?: number) => anchor(lines, a.text, a.before, a.after, tracked, hint)

/** The anchor a note had before its suggestion was applied (and after, once undone): Ctrl+Z / redo swap them. */
export const otherAnchor = new Map<string, Anchor>()

/** Re-anchors a note against the file's current lines; true if its position or stale flag changed. */
export function reanchor(n: Note, lines: string[] | undefined, tracked = toLoc(n.data), hint = tracked.start): boolean {
  let loc: Loc, stale: boolean
  if (!lines) { missing.add(n.data.id); loc = tracked; stale = true }
  else {
    missing.delete(n.data.id)
    ;({ loc, stale } = find(lines, n.data.anchor, tracked, hint))
    // An applied suggestion was undone (or redone): the code the note had before is back, so is its anchor.
    const alt = otherAnchor.get(n.data.id)
    if (stale && alt) {
      const r = find(lines, alt, tracked, hint)
      if (!r.stale) { otherAnchor.set(n.data.id, n.data.anchor); n.data.anchor = alt; loc = r.loc; stale = false }
    }
  }
  const range = { start: loc.start + 1, end: loc.end + 1 }
  if (range.start === n.data.range.start && range.end === n.data.range.end && !!n.data.stale === stale) return false
  logMove(n, range, stale, !!lines)
  n.data.range = range
  n.data.stale = stale
  return true
}

/** The log line of a note that went stale, came back, or followed its code to `range`. */
function logMove(n: Note, range: NoteData['range'], stale: boolean, fileThere: boolean): void {
  const { id, file } = n.data
  if (stale !== !!n.data.stale) {
    const why = !stale ? 'no longer stale' : fileThere ? 'stale (the code changed)' : 'stale (file not found)'
    log.info(`note ${id}: ${why} · ${file}`)
  } else if (range.start !== n.data.range.start) {
    log.info(`note ${id}: followed its code ${file} L${n.data.range.start} → L${range.start}`)
  }
}

/** Saves a note unless its code has unsaved changes: positions in a dirty editor are not the file on disk. */
export async function saveIfClean(n: Note): Promise<void> {
  const d = openDoc(docUri(n))
  if (d?.isDirty) return
  // On another branch, positions and stale are about this checkout only: don't rewrite the shared file for them.
  if (otherBranch(n) && n.base && JSON.stringify(n.base.messages) === JSON.stringify(n.data.messages) && n.base.status === n.data.status) return
  await store.save(n)
}

/** A file or folder note: only whether its file/folder is still there. True if that changed. */
async function checkTarget(n: Note): Promise<boolean> {
  let there = false
  try {
    const isFolder = !!((await wfs.stat(pathUri(n))).type & vscode.FileType.Directory)
    there = n.data.target === 'folder' ? isFolder : !isFolder
  } catch { /* gone */ }
  const was = missing.has(n.data.id)
  if (there) missing.delete(n.data.id); else missing.add(n.data.id)
  n.data.stale = !there
  if (was !== !there) log.info(`note ${n.data.id}: ${there ? 'found' : 'not found'} · ${n.data.file}`)
  return was !== !there
}

/** Every note against its file as it is now: file and folder notes checked, line notes re-anchored. */
export async function reanchorAll(): Promise<void> {
  const byFile = new Map<string, Note[]>()
  for (const n of notes()) {
    if (n.data.target) { await checkTarget(n); continue }
    const k = docUri(n).toString()
    byFile.set(k, [...(byFile.get(k) ?? []), n])
  }
  for (const [uri, list] of byFile) {
    const lines = (await linesOfUri(vscode.Uri.parse(uri))) ?? (await fixFolderPrefix(list))
    for (const n of list) await reanchorInFile(n, lines)
  }
}

/**
 * Notes whose file isn't there: an agent may have written the path with the workspace folder's name in front
 * ("runner/src/x.ts"). Fixed where that file exists; its lines, if any was.
 */
async function fixFolderPrefix(list: Note[]): Promise<string[] | undefined> {
  let lines: string[] | undefined
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
  return lines
}

/** One line note against its file's `lines` (undefined: the file is gone). */
async function reanchorInFile(n: Note, lines: string[] | undefined): Promise<void> {
  if (lines && n.data.range.start > lines.length) {
    await markPastEnd(n, lines.length)
    return
  }
  pastEnd.delete(n.data.id)
  if (lines && noAnchor(n.data.anchor)) {
    await adoptAnchor(n, lines)
    return
  }
  if (reanchor(n, lines)) await saveIfClean(n)
}

/** The note's lines start past the end of its file (`lineCount` lines): stale, said once. */
async function markPastEnd(n: Note, lineCount: number): Promise<void> {
  pastEnd.set(n.data.id, lineCount)
  if (n.data.stale) return
  n.data.stale = true
  log.warn(`note ${n.data.id}: line ${n.data.range.start} is past the end of ${n.data.file} (${lineCount} lines)`)
  await saveIfClean(n)
}

/** A note an agent created without an anchor: take it from the code at its range, once. */
async function adoptAnchor(n: Note, lines: string[]): Promise<void> {
  const { start, end } = withinLines(toLoc(n.data), lines.length)
  n.data.anchor = await anchorAt(lines, start, end, n.folder)
  await saveIfClean(n)
}

/** The lines of a selection: one ending at column 0 or inside the indentation of a line does not include that line. */
export function rangeLines(doc: vscode.TextDocument, s: vscode.Range): Loc {
  let end = s.end.line
  if (end > s.start.line && !doc.lineAt(end).text.slice(0, s.end.character).trim()) end--
  return { start: s.start.line, end }
}

export const selectedLines = (editor: vscode.TextEditor): Loc => rangeLines(editor.document, editor.selection)

/** Code Notes' own folder (notes, README): no notes on those. */
export const inNotesFolder = (uri: vscode.Uri) => uri.path.includes(`/${folderName()}/`)

/** Files created just now (a few seconds): where code whose file disappeared may have gone (git mv, mv, refactors). */
export const recentCreates: { uri: vscode.Uri; at: number }[] = []

/** How long a created file is looked in for code that disappeared elsewhere. */
const RECENT_MS = 15_000

/**
 * The first file created just now, in a workspace folder `inFolder` accepts, whose lines `matches` accepts: its uri
 * and what `matches` returned.
 */
export async function findMovedFile<T>(
  inFolder: (f: vscode.WorkspaceFolder | undefined) => boolean,
  matches: (lines: string[]) => T | undefined,
): Promise<{ uri: vscode.Uri; found: T } | undefined> {
  for (const c of recentCreates) {
    if (!inFolder(vscode.workspace.getWorkspaceFolder(c.uri))) continue
    const lines = await linesOfUri(c.uri)
    const found = lines && matches(lines)
    if (found) return { uri: c.uri, found }
  }
  return undefined
}

/** Notes whose file disappeared: their code looked for in the files created just now; found, the note moves there. */
export async function followMovedFiles(): Promise<void> {
  const cutoff = Date.now() - RECENT_MS
  while (recentCreates.length && recentCreates[0].at < cutoff) recentCreates.shift()
  for (const n of notes()) {
    if (n.data.target) { await checkTarget(n); continue }
    try { await wfs.stat(docUri(n)); continue } catch { /* gone */ }
    const moved = blankAnchor(n.data.anchor) ? undefined : await findMovedFile(
      (f) => !!f && f === n.folder,
      (lines) => { const r = find(lines, n.data.anchor, toLoc(n.data)); return r.stale ? undefined : r.loc },
    )
    if (moved) await moveNoteTo(n, moved.uri, moved.found)
    else if (reanchor(n, undefined)) await store.save(n)
  }
  refreshAll()
}

/** A note follows its code into the file `uri`, at `loc`. */
async function moveNoteTo(n: Note, uri: vscode.Uri, loc: Loc): Promise<void> {
  const file = relPath(n.folder, uri)
  log.appendLine(`note ${n.data.id}: ${n.data.file} moved to ${file}`)
  n.data.file = file
  n.data.range = { start: loc.start + 1, end: loc.end + 1 }
  // pastEnd stays as it is: reanchorAll, which runs first, left none for a file that is gone.
  n.data.stale = false
  missing.delete(n.data.id)
  await store.save(n)
}

/** A file or folder renamed in the editor (Explorer, a refactoring): notes on it, or inside it, follow. */
export async function followRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  for (const n of notes()) {
    const old = pathUri(n).path
    if (old !== oldUri.path && !old.startsWith(oldUri.path + '/')) continue
    const folder = vscode.workspace.getWorkspaceFolder(newUri)
    if (!folder) continue
    n.data.file = relPath(folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length)))
    missing.delete(n.data.id)
    await store.save(n)
  }
}
