// When VS Code may open a comment box: no commenting range on any line (no "+" bar in the gutter), except in the file
// where Add Note is opening one, until that box is done with.

import * as vscode from 'vscode'
import { controller } from './ports'
import { inNotesFolder } from './notesFolder'
import { Poll, sleep, waitUntil } from './timing'

/** The file (uri) whose lines are commentable while Add Note's box is open there; undefined: none. */
let addingIn: string | undefined

/** When VS Code last asked for a file's commenting ranges: an editor that has just opened asks before it draws its threads. */
export const rangesAskedAt = new Map<string, number>()

export const rangeProvider: vscode.CommentingRangeProvider = {
  provideCommentingRanges: (doc) => {
    rangesAskedAt.set(doc.uri.toString(), Date.now())
    const adding = doc.uri.toString() === addingIn && vscode.workspace.getWorkspaceFolder(doc.uri) && doc.lineCount && !inNotesFolder(doc.uri)
    return adding ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []
  },
}

/** At least this long before the box is asked for: the comment widgets settle. */
const SETTLE_MS = 120
/** The window asks for the file's ranges again within a round trip: looked for often (it is usually quick), for at
 *  most a second (a slow remote link). */
const RANGES_ASKED: Poll = { tries: 100, everyMs: 10 }

/** The scheme of a comment box's input editor. */
export const COMMENT_INPUT = 'comment'

/** What ends the ranges once the person is back in the code. */
let watching: vscode.Disposable | undefined

/** The active file commentable; resolves once the window has the ranges and a box may be opened. They stay until
 *  endComments: never on a timer, as VS Code redraws every comment widget of the file when the ranges change and the
 *  open box loses the keyboard. */
export async function allowComments(): Promise<void> {
  const u = vscode.window.activeTextEditor?.document.uri.toString()
  watching?.dispose()
  watching = undefined
  addingIn = u
  controller().commentingRangeProvider = rangeProvider
  const t0 = Date.now()
  // At least SETTLE_MS, and until the window has asked for the file's ranges again: over a slow link that round trip
  // takes longer, and the box would not open.
  if (u) await waitUntil(() => (rangesAskedAt.get(u) ?? 0) >= t0, RANGES_ASKED)
  const left = SETTLE_MS - (Date.now() - t0)
  if (left > 0) await sleep(left)
}

/** The box is open: the ranges end when the person is back in the code (a click or a key in an editor, another
 *  file), as the box's own close (trash icon) tells the extension nothing. */
export function endCommentsWhenBack(): void {
  watching?.dispose()
  const back = vscode.TextEditorSelectionChangeKind
  // The box's own input is a text editor too (scheme 'comment'): typing in it is not being back in the code.
  const code = (e: vscode.TextEditor | undefined): e is vscode.TextEditor => !!e && e.document.uri.scheme !== COMMENT_INPUT
  watching = vscode.Disposable.from(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (code(e.textEditor) && (e.kind === back.Keyboard || e.kind === back.Mouse)) endComments()
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => { if (code(e) && e.document.uri.toString() !== addingIn) endComments() }),
  )
}

/** No commenting ranges again (a note saved from the box, the box closed, the person back in the code). */
export function endComments(): void {
  watching?.dispose()
  watching = undefined
  if (addingIn === undefined) return
  addingIn = undefined
  controller().commentingRangeProvider = rangeProvider
}
