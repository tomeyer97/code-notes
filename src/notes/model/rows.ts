// A row of the Code Notes view as a command gets it (sidebar/nodes.ts's Node has these kinds, and more). Commands
// only look at these shapes, so the notes don't depend on the view's row type.

import type { Note } from '../store'

export type NoteRow = { kind: 'note'; note: Note }
export type SessionRow = { kind: 'session'; name: string }
export type BrokenRow = { kind: 'broken'; uri: string; why: string }

/** `x` is a row of this kind. */
export function isRow<T extends { kind: string }>(x: unknown, kind: T['kind']): x is T {
  return !!x && typeof x === 'object' && (x as { kind?: unknown }).kind === kind
}

/** A note row's note. */
export const noteOfRow = (x: unknown): Note | undefined => (isRow<NoteRow>(x, 'note') ? x.note : undefined)
