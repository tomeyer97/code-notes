// "This note is about these lines now": the one state change behind a new note, Move Here, Keep Here (a stale note
// takes the code at its lines) and an applied suggestion.

import * as vscode from 'vscode'
import type { Loc } from '../core/anchors/anchor'
import type { NoteData } from '../core/format/noteModel'
import { docLines, relPath } from '../platform/documents'
import { anchorAt, markPlaced } from './location'
import { range1Of } from './model/lines'
import type { Note } from './store'

/** Where a note on lines is: its file, its 1-based lines, and their anchor (with the commit and branch). */
export type LinesPlace = Pick<NoteData, 'file' | 'range' | 'anchor'>

/** The place of lines `loc` of `doc` in workspace folder `folder`. */
export async function linesAt(doc: vscode.TextDocument, loc: Loc, folder: vscode.WorkspaceFolder): Promise<LinesPlace> {
  return { file: relPath(folder, doc.uri), range: range1Of(loc), anchor: await anchorAt(docLines(doc), loc.start, loc.end, folder) }
}

/** What becomes of the exact text a note is about when it is placed: this one (none: undefined), or `'keep'` it when
 *  it is still in the new lines (else it is dropped). */
export type SelectionAfter = NoteData['selection'] | 'keep'

/**
 * Note `n` is about lines `loc` of `doc` (in workspace folder `folder`) now: its file and lines, a new anchor on them,
 * the exact text as `selection` says; not stale, its file found. Nothing is saved or announced: the caller does.
 */
export async function placeAt(n: Note, doc: vscode.TextDocument, loc: Loc, folder: vscode.WorkspaceFolder, selection: SelectionAfter): Promise<void> {
  const at = await linesAt(doc, loc, folder)
  n.folder = folder
  n.data.file = at.file
  n.data.range = at.range
  n.data.anchor = at.anchor
  const sel = selection === 'keep' ? n.data.selection : selection
  if (sel && (selection !== 'keep' || at.anchor.text.includes(sel.text))) n.data.selection = sel
  else delete n.data.selection
  markPlaced(n)
}
