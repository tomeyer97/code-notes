// When VS Code may open a comment box: no commenting range on any line (no "+" bar in the gutter), except for a moment
// while Add Note opens one.

import * as vscode from 'vscode'
import { controller } from './ports'
import { inNotesFolder } from './notesFolder'
import { Poll, sleep, waitUntil } from './timing'

/** Commenting ranges: none, except until this time (a note box being opened). */
let addingUntil = 0

/** When VS Code last asked for a file's commenting ranges: an editor that has just opened asks before it draws its threads. */
export const rangesAskedAt = new Map<string, number>()

export const rangeProvider: vscode.CommentingRangeProvider = {
  provideCommentingRanges: (doc) => {
    rangesAskedAt.set(doc.uri.toString(), Date.now())
    const adding = Date.now() < addingUntil && vscode.workspace.getWorkspaceFolder(doc.uri) && doc.lineCount && !inNotesFolder(doc.uri)
    return adding ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []
  },
}

/** How long the whole file is commentable for a note box to open. */
const ADDING_MS = 1500
/** The provider is set again a little after that, so VS Code asks again and the ranges are gone. */
const ADDING_OFF_AFTER_MS = 50
/** At least this long before the box is asked for: the comment widgets settle. */
const SETTLE_MS = 120
/** The window asks for the file's ranges again within a round trip: looked for often (it is usually quick), for at
 *  most a second (a slow remote link). */
const RANGES_ASKED: Poll = { tries: 100, everyMs: 10 }

let rangesOff: NodeJS.Timeout | undefined

/** The whole file commentable for a moment; resolves once the window has the ranges and a box may be opened. */
export async function allowComments(ms = ADDING_MS): Promise<void> {
  addingUntil = Date.now() + ms
  controller().commentingRangeProvider = rangeProvider
  const t0 = Date.now()
  clearTimeout(rangesOff)
  rangesOff = setTimeout(() => { controller().commentingRangeProvider = rangeProvider }, ms + ADDING_OFF_AFTER_MS)
  // At least SETTLE_MS, and until the window has asked for the file's ranges again: over a slow link that round trip
  // takes longer, and the box would not open.
  const u = vscode.window.activeTextEditor?.document.uri.toString()
  if (u) await waitUntil(() => (rangesAskedAt.get(u) ?? 0) >= t0, RANGES_ASKED)
  const left = SETTLE_MS - (Date.now() - t0)
  if (left > 0) await sleep(left)
}
