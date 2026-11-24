// Undo for what Code Notes did to notes (resolve, delete, move, mark read…): the last action only, from its toast or
// "Code Notes: Undo".

import * as vscode from 'vscode'
import { setCtx } from '../platform/context'
import { NoteData } from '../core/format/noteModel'
import { Note } from './store'
import { fireAndForget } from '../platform/run'

/** The last undoable action: the toast's Undo, and "Code Notes: Undo" after the toast is gone. */
let lastUndo: { what: string; run: () => Promise<void> } | undefined

/** `what` was done; `run` takes it back. Quiet: nothing pops up; "Code Notes: Undo" still brings it back. */
export function offerUndo(what: string, run: () => Promise<void>, quiet = false): void {
  const entry = { what, run }
  lastUndo = entry
  fireAndForget(setCtx('codeNotes.canUndo', true), 'undo: setCtx codeNotes.canUndo')
  if (!quiet) fireAndForget(vscode.window.showInformationMessage(what, 'Undo').then((pick) => { if (pick === 'Undo') return undoLast(entry) }), 'undo: window.showInformationMessage')
}

async function undoLast(entry = lastUndo): Promise<void> {
  if (!entry || entry !== lastUndo) return // already undone
  lastUndo = undefined
  fireAndForget(setCtx('codeNotes.canUndo', false), 'undo: setCtx codeNotes.canUndo')
  await entry.run()
  vscode.window.setStatusBarMessage(`$(discard) Undone: ${entry.what}`, 3000)
}

/** codeNotes.undo */
export const undo = () => (lastUndo ? undoLast() : vscode.window.setStatusBarMessage('$(info) Nothing to undo', 2500))

/** A copy of a note's data, to put back (a failed save, an undo). */
export const snapshot = (n: Note): NoteData => structuredClone(n.data)
