// Notes follow edits live: each edit shifts the lines of the notes below it, and shortly after typing stops each note
// is found again by its code (moved, stale). Saved to disk with the file only: positions in a dirty editor are not the
// file on disk.

import * as vscode from 'vscode'
import { Loc } from '../core/anchors/anchor'
import { shift, swallows } from '../core/anchors/lineFollow'
import { docLines } from '../platform/documents'
import { WorkspaceEvents } from '../platform/events'
import { lineEdit } from '../platform/followEdits'
import { Debouncer } from '../platform/debounce'
import { REANCHOR_NOTES_MS } from '../platform/timings'
import { lineNotesFor } from './location'
import { reanchor } from './reanchor'
import { locOf, range1Of } from './model/lines'
import { notesChanged, notesModel } from './model'
import type { Note } from './store'

/** Writes a note (the store's save). */
type Save = (n: Note) => Promise<boolean>

export function followEdits(events: WorkspaceEvents, save: Save): vscode.Disposable {
  // One re-anchoring per document, after its typing stops; dropped with the extension.
  const pending = new Debouncer('notes: re-anchor after typing')
  return vscode.Disposable.from(
    pending,
    events.onDidEditDocument((e) => edited(e, pending, save)),
    events.onDidSaveDocument((doc) => notesModel().batch(() => saved(doc, save))),
  )
}

/** The notes of an edited document move with its lines now; found again by their code once typing stops. */
function edited(e: vscode.TextDocumentChangeEvent, pending: Debouncer, save: Save): void {
  const list = lineNotesFor(e.document.uri)
  if (!list.length) return
  const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start))
  const before = new Map<string, Loc>()
  for (const n of list) {
    let loc = locOf(n.data.range)
    before.set(n.data.id, loc)
    let swallowed = false
    for (const c of changes) {
      const edit = lineEdit(c)
      if (swallows(loc, edit)) swallowed = true
      loc = shift(loc, edit)
    }
    // A replace of the whole note (a reload from disk, git stash/checkout): search for it rather than stretch it.
    if (swallowed) loc = before.get(n.data.id)!
    n.data.range = range1Of(loc)
  }
  notesChanged({ kind: 'edited', ids: list.map((n) => n.data.id) })
  pending.later(e.document.uri.toString(), REANCHOR_NOTES_MS, () => notesModel().batch(async () => {
    const ls = docLines(e.document)
    const now = lineNotesFor(e.document.uri)
    for (const n of now) reanchor(n, ls, locOf(n.data.range), before.get(n.data.id)?.start)
    notesChanged({ kind: 'placed', ids: now.map((n) => n.data.id) })
    if (!e.document.isDirty) for (const n of now) await save(n)
  }))
}

/** A document saved: its notes found again by their code, and saved with it. */
async function saved(doc: vscode.TextDocument, save: Save): Promise<void> {
  const list = lineNotesFor(doc.uri)
  if (!list.length) return
  const ls = docLines(doc)
  for (const n of list) { reanchor(n, ls); await save(n) }
  notesChanged({ kind: 'placed', ids: list.map((n) => n.data.id) })
}
