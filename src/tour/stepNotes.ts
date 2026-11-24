// Notes beside the walk: notes on the step's lines fold under its card, and notes asked from steps are drawn again
// when the walk moves (their back-link says less while you walk their journey).

import * as vscode from 'vscode'
import { notesStore } from './ports'
import { visibleNotes } from '../notes/visible'
import { stepLinkOf } from '../notes/model/journeyLink'
import { notesFor } from '../notes/location'
import { setCollapse } from '../threads/settle'
import { syncThread, threads } from '../threads/sync'

/** Notes on lines `at` of `uri` fold, so the step comes first (they stay unread). */
export function foldNotesOverlapping(uri: vscode.Uri, at: { start: number; end: number }): void {
  for (const note of notesFor(uri)) {
    const overlaps = note.data.range.start <= at.end && note.data.range.end >= at.start
    if (!overlaps) continue
    const thread = threads.get(note.data.id)
    if (thread) setCollapse(thread, vscode.CommentThreadCollapsibleState.Collapsed, note.data.id)
  }
}

/** Each note asked from a journey step: its thread is drawn again. */
export function syncStepNotes(): void {
  for (const n of visibleNotes()) if (stepLinkOf(n)) syncThread(n)
}
