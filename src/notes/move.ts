// Moving a note to other code: the selection now, or select it and click Move Here.

import * as vscode from 'vscode'
import { byId, setCtx, store } from '../app'
import { Note } from './store'
import { noteTitle, rangeLabel } from '../core/text'
import { anchorAt, docUri, markPlaced, placement, saveIfClean, selectedLines } from './location'
import { reanchorAll } from './reanchor'
import { locOf, range1Of, withinLines } from './model/lines'
import { notesChanged, notesModel } from './model'
import { docLines, relPath } from '../platform/documents'
import { partialSelection } from './create'
import { offerUndo, snapshot } from './undo'
import { notesFrom } from './which'
import { fireAndForget } from '../platform/run'
import { Cmd } from '../platform/commands'

export let moveItem: vscode.StatusBarItem

let pendingMove: string | undefined

export async function startMove(n: Note): Promise<void> {
  pendingMove = n.data.id
  fireAndForget(setCtx('codeNotes.moving', true), 'move: setCtx codeNotes.moving')
  moveItem.text = `$(move) Move "${noteTitle(n, 30)}" to the selection`
  moveItem.tooltip = 'Select the code, then click here. Esc cancels.'
  moveItem.show()
  const pick = await vscode.window.showInformationMessage(`Move note "${noteTitle(n)}": select the code it belongs to, then click Move Here.`, 'Move Here', 'Cancel')
  if (pick === 'Move Here') await completeMove()
  else if (pick === 'Cancel') cancelMove()
}

export function cancelMove(): void {
  pendingMove = undefined
  fireAndForget(setCtx('codeNotes.moving', false), 'move: setCtx codeNotes.moving')
  moveItem.hide()
}

export async function completeMove(): Promise<void> {
  const n = pendingMove ? byId(pendingMove) : undefined
  const editor = vscode.window.activeTextEditor
  if (!n) { cancelMove(); return }
  if (!editor || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
    vscode.window.setStatusBarMessage('$(info) Select the code in an editor first', 2500)
    return
  }
  const before = snapshot(n)
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)!
  const loc = selectedLines(editor)
  n.folder = folder
  n.data.file = relPath(folder, editor.document.uri)
  n.data.range = range1Of(loc)
  // The new code, its branch, and the exact text if only part of a line is selected.
  n.data.anchor = await anchorAt(docLines(editor.document), loc.start, loc.end, folder)
  const sel = partialSelection(editor.document, editor.selection)
  if (sel) n.data.selection = sel; else delete n.data.selection
  markPlaced(n)
  cancelMove()
  await store.save(n)
  notesChanged({ kind: 'placed', ids: [n.data.id] })
  offerUndo(`Note moved to ${n.data.file} ${rangeLabel(n)}`, () => notesModel().batch(async () => {
    n.data = before
    await store.save(n)
    await reanchorAll()
    notesChanged({ kind: 'placed', ids: [n.data.id] })
  }))
}

/** The status bar item of a move in progress (click: Move Here). */
export function createMoveItem(): void {
  moveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51)
  moveItem.command = Cmd.completeMove
  moveItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
}

/** codeNotes.acceptCode ("Keep here" on a stale note): the note takes the code at its lines now as its anchor. */
export const acceptCode = async (arg?: any) => {
  const [n] = notesFrom(arg)
  if (!n || placement.missing(n.data.id)) return
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const { start, end } = withinLines(locOf(n.data.range), doc.lineCount)
  // Kept here on this branch; an exact text that is gone is dropped.
  n.data.anchor = await anchorAt(docLines(doc), start, end, n.folder)
  if (n.data.selection && !n.data.anchor.text.includes(n.data.selection.text)) delete n.data.selection
  // Not missing: checked above.
  n.data.stale = false
  placement.found(n.data.id)
  await saveIfClean(n)
  notesChanged({ kind: 'placed', ids: [n.data.id] })
}

export const moveToSelection = (arg?: any) => {
  const [n] = notesFrom(arg)
  if (!n) return
  const e = vscode.window.activeTextEditor
  const own = e && docUri(n).toString() === e.document.uri.toString() && !e.selection.isEmpty
    && e.selection.start.line + 1 >= n.data.range.start && e.selection.end.line + 1 <= n.data.range.end
  // A selection elsewhere: move there now (with Undo). Otherwise ask for one.
  if (e && !e.selection.isEmpty && !own) { pendingMove = n.data.id; return completeMove() }
  return startMove(n)
}
