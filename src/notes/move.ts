// Moving a note to other code: the selection now, or select it and click Move Here.

import * as vscode from 'vscode'
import { byId, setCtx, store } from '../app'
import { commitInfo } from '../identity'
import { refreshAll } from '../refresh'
import { Note } from '../store'
import { plain } from '../text'
import { captureAnchor, docUri, linesOf, missing, pastEnd, reanchorAll, relPath, saveIfClean, selectedLines, toLoc } from '../threads/anchoring'
import { lines } from '../threads/comments'
import { partialSelection } from './create'
import { offerUndo, snapshot } from './status'
import { notesFrom } from './target'

export let moveItem: vscode.StatusBarItem

let pendingMove: string | undefined

export async function startMove(n: Note): Promise<void> {
  pendingMove = n.data.id
  setCtx('codeNotes.moving', true)
  moveItem.text = `$(move) Move "${plain(n.data.messages[0]?.body ?? '', 30)}" to the selection`
  moveItem.tooltip = 'Select the code, then click here. Esc cancels.'
  moveItem.show()
  const pick = await vscode.window.showInformationMessage(`Move note "${plain(n.data.messages[0]?.body ?? '', 40)}": select the code it belongs to, then click Move Here.`, 'Move Here', 'Cancel')
  if (pick === 'Move Here') await completeMove()
  else if (pick === 'Cancel') cancelMove()
}

export function cancelMove(): void {
  pendingMove = undefined
  setCtx('codeNotes.moving', false)
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

/** The status bar item of a move in progress (click: Move Here). */
export function createMoveItem(): void {
  moveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51)
  moveItem.command = 'codeNotes.completeMove'
  moveItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
}

export const keepHere = async (arg?: any) => {
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
