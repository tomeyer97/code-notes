// The thread view's calls for the features around it (the notes' reveal and replies, Claude's progress, the check,
// the tour): through the one ThreadView the threads' activate made. Before that, there are no threads.
import type * as vscode from 'vscode'
import type { Note } from '../notes/store'
import type { ThreadView } from './view'

let view: ThreadView | undefined

/** threads/index.ts only: the view the calls below go to (undefined: the extension stopped). */
export function useThreadView(v: ThreadView | undefined): void {
  view = v
}

/** The notes' threads by note id (read-only: the view makes and removes them). */
export const threads = {
  get: (id: string): vscode.CommentThread | undefined => view?.get(id),
  has: (id: string): boolean => !!view?.has(id),
}

/** Notes opened (a row clicked) before their thread was made (its editor was still opening): made expanded. */
export const expandWhenMade = {
  add: (id: string): void => view?.expandOnCreate(id),
  delete: (id: string): boolean => !!view?.cancelExpandOnCreate(id),
}

/** The note's thread made, changed or removed to match the note. */
export const syncThread = (n: Note): void => view?.sync(n)

/** Every note shown has its thread, and no thread is left of a note gone. Returns the ids of the notes shown. */
export const syncThreads = (): Set<string> => view?.syncAll() ?? new Set()

export const noteOfThread = (t: vscode.CommentThread): Note | undefined => view?.noteOf(t)
