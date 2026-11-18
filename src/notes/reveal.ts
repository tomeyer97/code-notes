// Opening a note: its thread (expanded, the others on its lines folded), its row, or a page when its file is gone;
// the keyboard in its thread; a file at a line (a link in a thread).

import * as vscode from 'vscode'
import { byId, log, mapPanel, showError } from '../app'
import { ownSelection } from '../claudeLinks'
import { markRead, visitFrom } from '../seen'
import { journeyOfNote } from '../sidebar/journeyRows'
import { Node, noteNode } from '../sidebar/nodes'
import { matchesFilter } from '../sidebar/notesFilter'
import { treeView } from '../sidebar/notesTree'
import { Note } from '../store'
import { threadRange } from '../threads/comments'
import { editorSettling, editorShownAt, setCollapse, settling } from '../threads/settle'
import { expandWhenMade, revealed, syncThread, threads } from '../threads/sync'
import { openRef } from '../tour/refs'
import { walk } from '../tour/instances'
import { wfs } from '../wfs'
import { rangesAskedAt, waitUntil } from './commentRanges'
import { clampLines, docUri, missing, notesFor } from './location'
import { startMove } from './move'
import { orphanPage } from './pages'
import { resolve } from './status'
import { notesFrom } from './which'

export async function reveal(n: Note, column?: vscode.ViewColumn, preserveFocus = false): Promise<void> {
  if (missing.has(n.data.id)) return revealGone(n)
  const prev = revealed.id
  revealed.id = n.data.id
  for (const id of [...visitFrom.keys()]) if (id !== n.data.id) visitFrom.delete(id)
  if (prev && prev !== n.data.id) { const p = byId(prev); if (p) syncThread(p) }
  const col = column ?? targetColumn(n)
  const r = threadRange(n)
  ownSelection()
  // The caret goes with the show: one call into the window.
  const selection = new vscode.Selection(r.start, r.start)
  const editor = await vscode.window.showTextDocument(docUri(n), { preview: true, preserveFocus, selection, ...(col ? { viewColumn: col } : {}) })
  revealLines(editor, r)
  // Its thread not made yet (its editor is still opening: made once it has settled): it is made expanded.
  if (!threads.has(n.data.id)) expandWhenMade.add(n.data.id)
  syncThread(n)
  if (threads.has(n.data.id)) expandWhenMade.delete(n.data.id)
  focusThread(n)
  // Read: the threads and the list follow now; storing it is not waited for (a round trip to the window).
  void markRead([n], n).then(undefined, (e) => log.error(`mark read: ${e}`))
  // Its row in the list, once the list has been redrawn for it (a row revealed while the list redraws can't be found).
  revealInList(n)
}

/** A note whose file is gone: its page, and a choice: Move it to code, or Resolve it. */
async function revealGone(n: Note): Promise<void> {
  revealInList(n)
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(orphanPage(n)), { preview: true })
  await markRead([n])
  const pick = await vscode.window.showWarningMessage(`${n.data.file} no longer exists. Select the code this note belongs to, then use Move.`, 'Move…', 'Resolve')
  if (pick === 'Move…') await startMove(n)
  else if (pick === 'Resolve') await resolve([n])
}

/** Where the note's file opens: the column it is already shown in; never in the map's group (the code group, reusing
 *  its preview tab); else VS Code's choice (undefined). */
function targetColumn(n: Note): vscode.ViewColumn | undefined {
  const uri = docUri(n)
  if (vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString())) return walk.columnFor(uri)
  const inMapGroup = mapPanel.viewColumn !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn === mapPanel.viewColumn
  return inMapGroup ? walk.codeColumn() : undefined
}

/** A range taller than this is shown from its end. */
const TALL_LINES = 12

/**
 * The note's lines in view. A long range: its thread hangs below its last line, so that end (and the thread) is what
 * comes into view, not a screen of highlighted code with the question below the fold.
 */
function revealLines(editor: vscode.TextEditor, r: vscode.Range): void {
  if (r.end.line - r.start.line > TALL_LINES) {
    editor.revealRange(new vscode.Range(Math.max(r.start.line, r.end.line - 3), 0, r.end.line, 0), vscode.TextEditorRevealType.AtTop)
  } else {
    editor.revealRange(new vscode.Range(r.start, r.end.translate(4)), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
}

/** Only this note's thread is open: others on the same lines collapse, so the one clicked is the one shown. */
function focusThread(n: Note): void {
  for (const other of notesFor(docUri(n))) {
    const t = threads.get(other.data.id)
    if (!t) continue
    const overlaps = other.data.range.start <= n.data.range.end && other.data.range.end >= n.data.range.start
    if (other === n) setCollapse(t, vscode.CommentThreadCollapsibleState.Expanded, other.data.id)
    else if (overlaps) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, other.data.id)
  }
}

/** A thread's widget is drawn this long after the window asked for its file's comments … */
const WIDGET_DRAWN_MS = 400
/** … and the command is never sent sooner than this. */
const MIN_FOCUS_WAIT_MS = 150

/**
 * The keyboard in a note's thread, not in the code under it (where typing would edit the file). VS Code's API can't put
 * the caret in a thread's reply box; "Focus Comment on Current Line" moves focus into the thread (Tab reaches Reply).
 */
export async function focusReply(n: Note): Promise<boolean> {
  const id = n.data.id
  await waitUntil(() => { const t = threads.get(id); return !!t && !settling(t) }, 20, 50)
  if (!threads.get(id)) return false
  // Its widget is drawn after the thread's first state arrives, and in an editor that has just opened, after the
  // editor has settled: too early, and the command finds no thread and the keyboard stays in the code.
  // An editor that has just opened asks for the file's comments, then draws their widgets: wait for that question.
  const u = docUri(n).toString()
  editorSettling(docUri(n))
  const shownAt = editorShownAt.get(u) ?? 0
  await waitUntil(() => (rangesAskedAt.get(u) ?? 0) >= shownAt, 40, 50)
  const since = Date.now() - Math.max(shownAt, rangesAskedAt.get(u) ?? 0)
  await new Promise((r) => setTimeout(r, Math.max(MIN_FOCUS_WAIT_MS, WIDGET_DRAWN_MS - since)))
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.toString() !== docUri(n).toString()) return false
  // The command looks for a thread on the caret's line: the thread's last line, where its widget hangs.
  const at = threadRange(n).end
  e.selection = new vscode.Selection(at.line, 0, at.line, 0)
  return vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine').then(() => true, () => false)
}

/** Selects the note's row in the sidebar, when the sidebar is open. */
function revealInList(n: Note): void {
  // A step's question is listed under its journey in the Journeys view, not in this one.
  if (!treeView.visible || !matchesFilter(n) || journeyOfNote(n)) return
  treeView.reveal(noteNode(n), { select: true, focus: false }).then(undefined, () => { /* not in the list */ })
}

/** codeNotes.openAt (a link in a thread): the file at a line; a step's reference while its journey is walked. */
export const openAt = async (folderUri: string, file: string, line: number, end?: number, step?: number) => {
  const lj = walk.tourJourney()
  if (step && lj && walk.touring() && lj.folder.uri.toString() === folderUri) return openRef(lj, file, line, end ?? line, step)
  const uri = vscode.Uri.joinPath(vscode.Uri.parse(folderUri), file)
  try { await wfs.stat(uri) } catch { void showError(`Code Notes: ${file} doesn't exist in this folder.`); return }
  const ed = await vscode.window.showTextDocument(uri, { preview: true })
  const pos = new vscode.Position(clampLines(ed.document, line, line).start, 0)
  ed.selection = new vscode.Selection(pos, pos)
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

/** codeNotes.reveal: a row's note, or the one at the cursor. */
export const revealCommand = (node?: Node) => {
  const [n] = notesFrom(node)
  if (n) return reveal(n)
}

/** codeNotes.openNoteFile: the note's JSON file. */
export const openNoteFile = (arg?: any) => {
  const [n] = notesFrom(arg)
  if (n) return vscode.window.showTextDocument(n.uri)
}

/** codeNotes.openNoteId: a note by its id (a link). */
export const openNoteId = (id: string) => {
  const n = byId(id)
  if (n) return reveal(n)
}
