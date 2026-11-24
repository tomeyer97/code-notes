// The note just opened (selection.revealed: its thread shows even when resolved, filtered out or in a hidden session)
// and the replies being visited in it (seen.ts visitFrom: "new" until another note is opened). Only these change them.

import { visitFrom } from './seen'
import { selection } from './model'
import type { Note } from './store'

/** The note just opened, if any (its id). */
export const revealedId = () => selection().revealed

/** `n` is the note just opened; the other notes' visits end. The note opened before it (its id), if another. */
export function setRevealed(n: Note): string | undefined {
  const prev = selection().revealed
  selection().revealed = n.data.id
  for (const id of [...visitFrom.keys()]) if (id !== n.data.id) visitFrom.delete(id)
  return prev !== n.data.id ? prev : undefined
}

/** Note `id` is no longer the one just opened (resolved, hidden, marked unread). `visit`: its visit ends too. */
export function forgetRevealed(id: string, visit = false): void {
  if (visit) visitFrom.delete(id)
  if (selection().revealed === id) selection().revealed = undefined
}
