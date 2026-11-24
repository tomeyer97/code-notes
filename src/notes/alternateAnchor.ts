// A second anchor a note may be found by, besides its own: the code it was on before its suggestion was applied (so
// Ctrl+Z, and redo, find it again), or the saved text of a note written on unsaved lines (so undoing the typo being
// fixed doesn't make it stale). Re-anchoring (reanchor.ts) tries it when the note's own anchor is not found.

import type { Loc } from '../core/anchors/anchor'
import type { Note } from './store'
import type { Anchor } from './location'

/** By note id: the anchor the note is also found by. */
export const alternateAnchor = new Map<string, Anchor>()

/** A stale note whose other code is back (a suggestion undone or redone, a typo undone), found by `find` with the
 *  alternate anchor. */
export function foundByAlternate(n: Note, find: (a: Anchor) => { loc: Loc; stale: boolean }): { loc: Loc; anchor: Anchor } | undefined {
  const alt = alternateAnchor.get(n.data.id)
  if (!alt) return undefined
  const r = find(alt)
  return r.stale ? undefined : { loc: r.loc, anchor: alt }
}

/** The note takes the alternate anchor (foundByAlternate); the one it had becomes the alternate (for a redo). */
export function swapToAlternate(n: Note, alt: Anchor): void {
  alternateAnchor.set(n.data.id, n.data.anchor)
  n.data.anchor = alt
}
