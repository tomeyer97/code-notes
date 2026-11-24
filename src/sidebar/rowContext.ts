// The contextValue of a Code Notes row: words joined by `;` that package.json's menus match (`viewItem =~ /^note/ &&
// viewItem =~ /stale/`). Made here only, from typed flags; test/notesRows.test.ts checks package.json against ROW_WORDS.
import type { NoteData } from '../core/format/noteModel'

/** A note row's flags, in the order they are written. */
export const NOTE_FLAGS = ['stale', 'unread', 'replied', 'asking'] as const
export type NoteFlag = (typeof NOTE_FLAGS)[number]

export type RowContext =
  | { kind: 'note'; status: NoteData['status']; flags: Partial<Record<NoteFlag, boolean>> }
  | { kind: 'session'; hidden: boolean; named: boolean }
  | { kind: 'broken'; known: boolean }
  | { kind: 'file' }

/** Every word a row's contextValue can hold. */
export const ROW_WORDS = ['note', 'open', 'resolved', ...NOTE_FLAGS, 'session', 'hidden', 'shown', 'named', 'broken', 'known', 'file'] as const

/** `note;open;stale;unread`, `session;hidden;named`, `broken;known`, `file`. */
export function rowContext(c: RowContext): string {
  switch (c.kind) {
    case 'note': return ['note', c.status, ...NOTE_FLAGS.filter((f) => c.flags[f])].join(';')
    case 'session': return ['session', c.hidden ? 'hidden' : 'shown', ...(c.named ? ['named'] : [])].join(';')
    case 'broken': return c.known ? 'broken;known' : 'broken'
    case 'file': return 'file'
  }
}
