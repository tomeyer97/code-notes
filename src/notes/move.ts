// Moving a note to other code: the selection now, or select it and click Move Here. Keep Here: a stale note takes
// the code at its lines.

import * as vscode from 'vscode'
import { store } from './ports'
import { byId } from './visible'
import { setCtx } from '../platform/context'
import { Note } from './store'
import { noteTitle, rangeLabel } from '../core/text'
import { docUri, placement, saveIfClean, selectedLines } from './location'
import { reanchorAll } from './reanchor'
import { locOf, withinLines } from './model/lines'
import { notesChanged, notesModel } from './model'
import { partialSelection } from './create'
import { offerUndo, snapshot } from './undo'
import { CommandArg, notesFrom } from './which'
import { fireAndForget } from '../platform/run'
import { Cmd } from '../platform/commands'
import { placeAt } from './place'
import { hint } from './hint'

/** The context key package.json's `when` clauses read while a move waits for its code (Esc cancels it). */
const MOVING_CTX = 'codeNotes.moving'

/**
 * A move waiting for the person to select the code: which note, its status bar item (click: Move Here) and the
 * context key. Idle, or moving one note; start, complete or cancel go from one to the other.
 */
class MoveMode implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51)
  /** The note being moved (its id), while a move waits. */
  private pending: string | undefined

  constructor() {
    this.item.command = Cmd.completeMove
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  }

  /** Waits for the code: the item, the context key and a message with Move Here. */
  async start(n: Note): Promise<void> {
    this.wait(n)
    this.item.text = `$(move) Move "${noteTitle(n, 30)}" to the selection`
    this.item.tooltip = 'Select the code, then click here. Esc cancels.'
    this.item.show()
    const question = `Move note "${noteTitle(n)}": select the code it belongs to, then click Move Here.`
    const pick = await vscode.window.showInformationMessage(question, 'Move Here', 'Cancel')
    if (pick === 'Move Here') await this.complete()
    else if (pick === 'Cancel') this.cancel()
  }

  /** The note waiting is `n`. */
  private wait(n: Note): void {
    this.pending = n.data.id
    fireAndForget(setCtx(MOVING_CTX, true), 'move: setCtx codeNotes.moving')
  }

  cancel(): void {
    this.pending = undefined
    fireAndForget(setCtx(MOVING_CTX, false), 'move: setCtx codeNotes.moving')
    this.item.hide()
  }

  /** The note waiting goes to the selection, with Undo (no selection in a workspace file: it keeps waiting). */
  async complete(): Promise<void> {
    const n = this.pending ? byId(this.pending) : undefined
    const editor = vscode.window.activeTextEditor
    if (!n) { this.cancel(); return }
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)
    if (!editor || !folder) { hint('Select the code in an editor first'); return }
    const before = snapshot(n)
    // The new code, its branch, and the exact text if only part of a line is selected.
    await placeAt(n, editor.document, selectedLines(editor), folder, partialSelection(editor.document, editor.selection))
    this.cancel()
    await store().save(n)
    notesChanged({ kind: 'placed', ids: [n.data.id] })
    offerUndo(`Note moved to ${n.data.file} ${rangeLabel(n)}`, () => notesModel().batch(async () => {
      n.data = before
      await store().save(n)
      await reanchorAll()
      notesChanged({ kind: 'placed', ids: [n.data.id] })
    }))
  }

  /** Moves `n` to the selection now. */
  moveNow(n: Note): Promise<void> {
    this.wait(n)
    return this.complete()
  }

  dispose(): void { this.item.dispose() }
}

let mode: MoveMode | undefined
const moveMode = () => (mode ??= new MoveMode())

/** The move mode, made when the notes start (its status bar item goes with them). */
export function createMoveMode(): vscode.Disposable { return moveMode() }

export const startMove = (n: Note) => moveMode().start(n)
export const cancelMove = () => moveMode().cancel()
export const completeMove = () => moveMode().complete()

/** codeNotes.acceptCode ("Keep here" on a stale note): the note takes the code at its lines now as its anchor. */
export const acceptCode = async (arg?: CommandArg) => {
  const [n] = notesFrom(arg)
  if (!n || placement.missing(n.data.id)) return
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  // Kept here on this branch; an exact text that is gone is dropped.
  await placeAt(n, doc, withinLines(locOf(n.data.range), doc.lineCount), n.folder, 'keep')
  await saveIfClean(n)
  notesChanged({ kind: 'placed', ids: [n.data.id] })
}

/** codeNotes.moveToSelection: a selection elsewhere: the note moves there now (with Undo); otherwise it asks for one. */
export const moveToSelection = (arg?: CommandArg) => {
  const [n] = notesFrom(arg)
  if (!n) return
  const e = vscode.window.activeTextEditor
  const own = e && docUri(n).toString() === e.document.uri.toString() && !e.selection.isEmpty
    && e.selection.start.line + 1 >= n.data.range.start && e.selection.end.line + 1 <= n.data.range.end
  if (e && !e.selection.isEmpty && !own) return moveMode().moveNow(n)
  return startMove(n)
}
