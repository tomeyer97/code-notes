// Where a note is: its file (or folder) on disk, and its lines followed as the code moves (anchor.ts finds them).

import * as vscode from 'vscode'
import { anchor, Loc } from '../anchor'
import { log, notes, store } from '../app'
import { commitInfo, otherBranch } from '../identity'
import { refreshAll } from '../refresh'
import { folderName, Note, NoteData } from '../store'
import { diskLines, docLines, wfs } from '../wfs'

const CONTEXT_LINES = 2

/** Notes whose code file does not exist (deleted or moved). */
export const missing = new Set<string>()

/** Notes whose range starts past the end of their file: note id -> the file's line count. */
export const pastEnd = new Map<string, number>()

/** The file or folder the note is about, on disk. */
export function pathUri(n: Note): vscode.Uri { return vscode.Uri.joinPath(n.folder.uri, n.data.file) }

/** A folder note's thread lives on a read-only page about the folder (there is no document to put it on). */
const FOLDER_SCHEME = 'code-notes-folder'

function folderPage(folder: vscode.WorkspaceFolder, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: FOLDER_SCHEME, path: `/${file} (folder)`, query: folder.uri.toString() })
}

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

export const toLoc = (d: NoteData): Loc => ({ start: d.range.start - 1, end: d.range.end - 1 })

/** The anchor a note had before its suggestion was applied (and after, once undone): Ctrl+Z / redo swap them. */
export const otherAnchor = new Map<string, NoteData['anchor']>()

/** Re-anchors a note against the file's current lines; true if its position or stale flag changed. */
export function reanchor(n: Note, lines: string[] | undefined, tracked = toLoc(n.data), hint = tracked.start): boolean {
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
  try { const st = await wfs.stat(pathUri(n)); there = n.data.target === 'folder' ? !!(st.type & vscode.FileType.Directory) : !(st.type & vscode.FileType.Directory) } catch { /* gone */ }
  const was = missing.has(n.data.id)
  if (there) missing.delete(n.data.id); else missing.add(n.data.id)
  n.data.stale = !there
  if (was !== !there) log.info(`note ${n.data.id}: ${there ? 'found' : 'not found'} · ${n.data.file}`)
  return was !== !there
}

export async function reanchorAll(): Promise<void> {
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

export function captureAnchor(lines: string[], start: number, end: number): NoteData['anchor'] {
  return {
    text: lines.slice(start, end + 1).join('\n'),
    before: lines.slice(Math.max(0, start - CONTEXT_LINES), start).join('\n'),
    after: lines.slice(end + 1, end + 1 + CONTEXT_LINES).join('\n'),
  }
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

/** Notes whose file disappeared: look for their code in files created just now (git mv, mv, refactors). */
export const recentCreates: { uri: vscode.Uri; at: number }[] = []

export async function followMovedFiles(): Promise<void> {
  const cutoff = Date.now() - 15_000
  while (recentCreates.length && recentCreates[0].at < cutoff) recentCreates.shift()
  for (const n of notes()) {
    if (n.data.target) { await checkTarget(n); continue }
    try { await wfs.stat(docUri(n)); continue } catch { /* gone */ }
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

/** The page a folder note's thread is on: the folder and what is in it. */
export function registerFolderPage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(FOLDER_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const rel = uri.path.replace(/^\//, '').replace(/ \(folder\)$/, '')
      const dir = vscode.Uri.joinPath(vscode.Uri.parse(uri.query), rel)
      let entries: [string, vscode.FileType][] = []
      try { entries = await wfs.readDirectory(dir) } catch { return `${rel}/ (not found)\n` }
      entries.sort((a, b) => (b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) || a[0].localeCompare(b[0]))
      return `${rel}/\n${entries.map(([name, t]) => `  ${name}${t & vscode.FileType.Directory ? '/' : ''}`).join('\n')}\n`
    },
  }))
}
