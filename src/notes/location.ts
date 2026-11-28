// Where a note is: its file (or folder) on disk, the document its thread is on, its lines, the notes on a line; and
// what is known about its placement beyond "stale" (model/placement.ts). Finding its lines again as the code moves:
// reanchor.ts; following moved and renamed files: moves.ts; following edits: followEdits.ts.

import * as vscode from 'vscode'
import { store } from './ports'
import { isDeepStrictEqual } from 'util'
import { visibleNotes } from './visible'
import { commitInfo, otherBranch } from '../platform/checkout'
import { openDoc } from '../platform/documents'
import { captureAnchor, NoteData } from '../core/format/noteModel'
import { Note } from './store'
import { folderPage } from './pages'
import { Placement } from './model/placement'

export type Anchor = NoteData['anchor']

/** Each note's file not found, or its lines past the end of its file. */
export const placement = new Placement()

/** The note's code is where it says again: not stale, not missing, not past the end of its file. */
export function markPlaced(n: Note): void {
  n.data.stale = false
  placement.found(n.data.id)
}

/** The file or folder the note is about, on disk. */
export function pathUri(n: Note): vscode.Uri { return vscode.Uri.joinPath(n.folder.uri, n.data.file) }

/** The document the note's thread is on. */
export function docUri(n: Note): vscode.Uri { return n.data.target === 'folder' ? folderPage(n.folder, n.data.file) : pathUri(n) }

export function notesFor(uri: vscode.Uri): Note[] {
  return visibleNotes().filter((n) => docUri(n).toString() === uri.toString())
}

/** Notes on lines (not a whole file or folder) of this document: the ones that follow edits. */
export const lineNotesFor = (uri: vscode.Uri) => notesFor(uri).filter((n) => !n.data.target)

/** Notes of this document covering 1-based line `line1`. */
export function notesAtLine(uri: vscode.Uri, line1: number): Note[] {
  return notesFor(uri).filter((n) => line1 >= n.data.range.start && line1 <= n.data.range.end)
}

/** A new anchor on 0-based lines `start`..`end`: their text and the lines around them, with the commit and branch. */
export async function anchorAt(lines: string[], start: number, end: number, folder: vscode.WorkspaceFolder): Promise<Anchor> {
  return { ...captureAnchor(lines, start, end), ...(await commitInfo(folder)) }
}

/** Never anchored: an agent wrote the note without one (empty, not even blank lines). Its anchor is taken from the
 *  code at its lines. */
export const neverAnchored = (a: Anchor) => !a.text && !a.before && !a.after

/** Nothing to recognise the code by: never anchored, or only blank lines (any file would "match" it). Such a note
 *  does not follow its code into another file. */
export const nothingToMatch = (a: Anchor) => !a.text.trim() && !a.before.trim() && !a.after.trim()

/**
 * On another branch, a note's lines and "stale" are about this checkout only: when nothing else changed since it was
 * read (its messages and status), the shared file is not rewritten for them.
 */
export function onlyLocalPlacementChanged(n: Note): boolean {
  if (!otherBranch(n) || !n.base) return false
  return isDeepStrictEqual(n.base.messages, n.data.messages) && n.base.status === n.data.status
}

/** Saves a note unless its code has unsaved changes (positions in a dirty editor are not the file on disk) or only
 *  where it is on another branch changed. */
export async function saveIfClean(n: Note): Promise<void> {
  if (openDoc(docUri(n))?.isDirty) return
  if (onlyLocalPlacementChanged(n)) return
  await store().saveFollowing(n)
}

/** The lines of a selection: one ending at column 0 or inside the indentation of a line does not include that line. */
export function rangeLines(doc: vscode.TextDocument, s: vscode.Range): { start: number; end: number } {
  let end = s.end.line
  if (end > s.start.line && !doc.lineAt(end).text.slice(0, s.end.character).trim()) end--
  return { start: s.start.line, end }
}

export const selectedLines = (editor: vscode.TextEditor) => rangeLines(editor.document, editor.selection)
