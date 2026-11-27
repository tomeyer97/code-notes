// Opening a note: its thread (expanded, the others on its lines folded), its row, or a page when its file is gone;
// the keyboard in its thread; a file at a line (a link in a thread).

import * as vscode from 'vscode'
import { notesPorts } from './ports'
import { byId } from './visible'
import { showError } from '../platform/run'
import { ownSelection } from '../codeLinks/claudeChatLinks'
import { markRead } from './seen'
import { notesModel } from './model'
import { Note } from './store'
import { wfs } from '../platform/workspaceFs'
import { rangesAskedAt } from './commentRanges'
import { docUri, placement } from './location'
import { clampLines } from './model/lines'
import { startMove } from './move'
import { orphanPage } from './pages'
import { resolve } from './status'
import { CommandArg, notesFrom } from './which'
import { fireAndForget } from '../platform/run'
import { setRevealed } from './revealed'
import { editorShown, hasThread, openThread, redrawThread, threadLines, threadReady } from './threadView'
import { Poll, sleep, waitUntil } from './timing'

export async function reveal(n: Note, column?: vscode.ViewColumn, preserveFocus = false): Promise<void> {
  if (placement.missing(n.data.id)) return revealGone(n)
  const prev = setRevealed(n)
  const p = prev ? byId(prev) : undefined
  if (p) redrawThread(p)
  const col = column ?? targetColumn(n)
  const r = threadLines(n)
  ownSelection()
  // The caret goes with the show: one call into the window.
  const caret = new vscode.Selection(r.start, r.start)
  const editor = await vscode.window.showTextDocument(docUri(n), { preview: true, preserveFocus, selection: caret, ...(col ? { viewColumn: col } : {}) })
  revealLines(editor, r)
  openThread(n)
  // Read: the threads and the list follow now; storing it is not waited for (a round trip to the window).
  fireAndForget(markRead([n], n), 'mark read')
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
  if (vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString())) return notesPorts().layout.columnFor(uri)
  const mapColumn = notesPorts().map.viewColumn
  const inMapGroup = mapColumn !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn === mapColumn
  return inMapGroup ? notesPorts().layout.codeColumn() : undefined
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

/**
 * How long focusReply waits for VS Code to draw a note's thread before it puts the keyboard there. VS Code's API says
 * nothing when a widget is drawn: each number is what was measured to be enough, with room for a slow machine.
 */
const FOCUS = {
  /** The thread made and its first state in the window (threads/settle.ts): up to a second. */
  thread: { tries: 20, everyMs: 50 } satisfies Poll,
  /** An editor that has just opened asks for the file's comments before it draws their widgets: up to two seconds. */
  asked: { tries: 40, everyMs: 50 } satisfies Poll,
  /** A thread's widget is drawn this long after the window asked for its file's comments … */
  drawnMs: 400,
  /** … and the command is never sent sooner than this. */
  minWaitMs: 150,
} as const

/**
 * The keyboard in a note's thread, not in the code under it (where typing would edit the file). VS Code's API can't put
 * the caret in a thread's reply box; "Focus Comment on Current Line" moves focus into the thread (Tab reaches Reply).
 */
export async function focusReply(n: Note): Promise<boolean> {
  // Its widget is drawn after the thread's first state arrives, and in an editor that has just opened, after the
  // editor has settled: too early, and the command finds no thread and the keyboard stays in the code.
  await waitUntil(() => threadReady(n.data.id), FOCUS.thread)
  if (!hasThread(n.data.id)) return false
  const u = docUri(n).toString()
  const shownAt = editorShown(docUri(n))
  await waitUntil(() => (rangesAskedAt.get(u) ?? 0) >= shownAt, FOCUS.asked)
  const since = Date.now() - Math.max(shownAt, rangesAskedAt.get(u) ?? 0)
  await sleep(Math.max(FOCUS.minWaitMs, FOCUS.drawnMs - since))
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.toString() !== u) return false
  // The command looks for a thread on the caret's line: the thread's last line, where its widget hangs.
  const at = threadLines(n).end
  e.selection = new vscode.Selection(at.line, 0, at.line, 0)
  return vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine').then(() => true, () => false)
}

/** Selects the note's row in the lists that show it. */
const revealInList = (n: Note) => notesModel().revealed(n)

/** A link in a thread to a file's lines (codeNotes.openAt): in workspace folder `folderUri`; `step`: a journey
 *  step's reference. */
export interface LineLink { folderUri: string; file: string; line: number; end?: number; step?: number }

/** Takes a link instead of opening its file (true: taken). */
export type LinkHandler = (link: LineLink) => boolean | Promise<boolean>

const linkHandlers: LinkHandler[] = []

/** From now on `h` is asked first about every link in a thread (until disposed): the tour takes a step's links
 *  while that journey is walked. */
export function takeLinks(h: LinkHandler): vscode.Disposable {
  linkHandlers.push(h)
  return new vscode.Disposable(() => { const i = linkHandlers.indexOf(h); if (i >= 0) linkHandlers.splice(i, 1) })
}

/** codeNotes.openAt (a link in a thread): the file at a line, unless a handler takes the link. */
export const openAt = async (folderUri: string, file: string, line: number, end?: number, step?: number) => {
  const link: LineLink = { folderUri, file, line, end, step }
  for (const h of linkHandlers) if (await h(link)) return
  const uri = vscode.Uri.joinPath(vscode.Uri.parse(folderUri), file)
  try {
    await wfs.stat(uri)
  } catch {
    fireAndForget(showError(`${file} doesn't exist in this folder.`), 'reveal: showError')
    return
  }
  const ed = await vscode.window.showTextDocument(uri, { preview: true })
  const pos = new vscode.Position(clampLines(ed.document, line, line).start, 0)
  ed.selection = new vscode.Selection(pos, pos)
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

/** codeNotes.reveal: a row's note, or the one at the cursor. */
export const revealCommand = (node?: CommandArg) => {
  const [n] = notesFrom(node)
  if (n) return reveal(n)
}

/** codeNotes.openNoteFile: the note's JSON file. */
export const openNoteFile = (arg?: CommandArg) => {
  const [n] = notesFrom(arg)
  if (n) return vscode.window.showTextDocument(n.uri)
}

/** codeNotes.openNoteId: a note by its id (a link). */
export const openNoteId = (id: string) => {
  const n = byId(id)
  if (n) return reveal(n)
}
