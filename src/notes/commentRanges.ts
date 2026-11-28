// When VS Code may open a comment box: no commenting range on any line (no "+" bar in the gutter), except in the file
// where Add Note is opening one, until that box is done with.

import * as vscode from 'vscode'
import { controller } from './ports'
import { inNotesFolder } from './notesFolder'
import { sleep } from './timing'

/** The file (uri) whose lines are commentable while Add Note's box is open there; undefined: none. */
let addingIn: string | undefined

/** When VS Code last asked for a file's commenting ranges: an editor that has just opened asks before it draws its threads. */
export const rangesAskedAt = new Map<string, number>()
/** Each runs the next time VS Code asks for a file's commenting ranges (by uri). */
const askedWaiters = new Map<string, Set<() => void>>()

export const rangeProvider: vscode.CommentingRangeProvider = {
  provideCommentingRanges: (doc) => {
    const key = doc.uri.toString()
    rangesAskedAt.set(key, Date.now())
    const waiting = askedWaiters.get(key)
    askedWaiters.delete(key)
    for (const w of waiting ?? []) w()
    const adding = doc.uri.toString() === addingIn && vscode.workspace.getWorkspaceFolder(doc.uri) && doc.lineCount && !inNotesFolder(doc.uri)
    return adding ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []
  },
}

/** At least this long before the box is asked for: the comment widgets settle. */
const SETTLE_MS = 120
/** The window asks for the file's ranges again within a round trip (seconds on a busy machine or a slow remote link);
 *  at most this long, for a window that never asks (the editor gone meanwhile). */
const RANGES_ASKED_MS = 10_000

/** Resolves when VS Code next asks for `uri`'s commenting ranges, or after `ms`. */
function nextAsk(uri: string, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); askedWaiters.get(uri)?.delete(done); resolve() }
    const timer = setTimeout(done, ms)
    askedWaiters.set(uri, (askedWaiters.get(uri) ?? new Set()).add(done))
  })
}

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
  const asked = u ? nextAsk(u, RANGES_ASKED_MS) : Promise.resolve()
  controller().commentingRangeProvider = rangeProvider
  const t0 = Date.now()
  // At least SETTLE_MS, and until the window has asked for the file's ranges again: before that the box would not open.
  await asked
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
