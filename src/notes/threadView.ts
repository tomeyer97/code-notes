// A note's comment thread, as opening a note needs it: the one place the notes reach into the threads' state
// (threads/ draws the threads; its sets and maps are changed here only, in the order they need).

import * as vscode from 'vscode'
import { threadRange } from '../threads/comments'
import { editorSettling, editorShownAt, setCollapse, settling } from '../threads/settle'
import { expandWhenMade, syncThread, threads } from '../threads/sync'
import { docUri, notesFor } from './location'
import type { Note } from './store'

/** Where the note's thread hangs (its lines as the editor has them). */
export const threadLines = (n: Note): vscode.Range => threadRange(n)

/** The note's thread drawn again as the note is now. */
export const redrawThread = (n: Note): void => syncThread(n)

/** The note's thread is made and its first state has reached the window. */
export function threadReady(id: string): boolean {
  const t = threads.get(id)
  return !!t && !settling(t)
}

export const hasThread = (id: string): boolean => threads.has(id)

/** When the editor of `uri` last came on screen (0: not known). */
export function editorShown(uri: vscode.Uri): number {
  editorSettling(uri) // notes the editors on screen now
  return editorShownAt.get(uri.toString()) ?? 0
}

/** The note's thread expanded (made expanded when its editor has not made it yet), and the others on its lines
 *  folded: the one opened is the one shown. */
export function openThread(n: Note): void {
  const id = n.data.id
  if (!threads.has(id)) expandWhenMade.add(id)
  syncThread(n)
  if (threads.has(id)) expandWhenMade.delete(id)
  for (const other of notesFor(docUri(n))) {
    const t = threads.get(other.data.id)
    if (!t) continue
    const overlaps = other.data.range.start <= n.data.range.end && other.data.range.end >= n.data.range.start
    if (other === n) setCollapse(t, vscode.CommentThreadCollapsibleState.Expanded, other.data.id)
    else if (overlaps) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, other.data.id)
  }
}

/** The note's thread folded (when it is drawn). */
export function foldThread(id: string): void {
  const t = threads.get(id)
  if (t) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, id)
}
