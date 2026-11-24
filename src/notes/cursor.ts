// The caret and the notes: codeNotes.cursorOnNote (menus and keys for the note at the caret), and the caret on a
// note counts as reading it.

import * as vscode from 'vscode'
import { WorkspaceEvents } from '../platform/events'
import { fireAndForget } from '../platform/run'
import { setCtx } from '../platform/context'
import { NOTES_CTX } from './model/contextKeys'
import { notesAtLine } from './location'
import { markRead, unread } from './seen'
import { whileTyping } from './model'
import type { NotesApi } from './model'

/** `hasThread`: the note's thread is shown (reading needs one); `arrived`: a journey step put the caret there just now
 *  (arriving is not reading). */
export interface CursorPorts { hasThread(id: string): boolean; arrived(): boolean }

export function followCursor(events: WorkspaceEvents, model: NotesApi, ports: CursorPorts): vscode.Disposable {
  return vscode.Disposable.from(
    events.onDidChangeActiveEditor(updateCursorContext),
    events.onDidChangeSelection((e) => cursorMoved(e, ports)),
    model.onDidChange((c) => { if (!whileTyping(c)) updateCursorContext() }),
  )
}

/** codeNotes.cursorOnNote: the caret is on a note's lines. */
export function updateCursorContext(): void {
  const e = vscode.window.activeTextEditor
  const line1 = e ? e.selection.active.line + 1 : -1
  fireAndForget(setCtx(NOTES_CTX.cursorOnNote, !!e && notesAtLine(e.document.uri, line1).length > 0), 'setCtx codeNotes.cursorOnNote')
}

/** The cursor on a note counts as reading it only when it is the one note on that line. */
function cursorMoved(e: vscode.TextEditorSelectionChangeEvent, ports: CursorPorts): void {
  updateCursorContext()
  const line1 = (e.selections[0]?.active.line ?? -2) + 1
  const here = notesAtLine(e.textEditor.document.uri, line1)
  if (ports.arrived()) return
  if (here.length === 1 && unread(here[0]) && ports.hasThread(here[0].data.id)) fireAndForget(markRead(here, here[0]), 'mark read at the cursor')
}
