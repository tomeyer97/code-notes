// The context keys the notes set for package.json's menus and views (`when` clauses name them: a test checks every one
// is used there), and their values worked out in one pass over the notes. Pure.

import type { Note } from '../store'
import type { Filter, GroupMode } from './query'

/** A context key's full name (some share a command's name: test/commands.test.ts looks for command ids written out). */
const ctx = <K extends string>(k: K) => `codeNotes.${k}` as const

export const NOTES_CTX = {
  /** Any note shown, or a note file that can't be read. */
  hasNotes: ctx('hasNotes'),
  /** Notes the Code Notes view lists (a check's questions are in the Check view): without any, it steps aside while a
   *  check is open. */
  listsNotes: ctx('listsNotes'),
  hasChecked: ctx('hasChecked'),
  filtered: ctx('filtered'),
  groupBy: ctx('groupBy'),
  hasSessions: ctx('hasSessions'),
  hasHiddenSessions: ctx('hasHiddenSessions'),
  showResolved: ctx('showResolved'),
  /** The caret is on a note's lines (notes/cursor.ts sets it: it follows the caret, not the notes). */
  cursorOnNote: ctx('cursorOnNote'),
} as const

export type NotesCtxKey = Exclude<keyof typeof NOTES_CTX, 'cursorOnNote'>

export interface NotesCtxInput {
  /** The notes shown. */
  notes: readonly Note[]
  /** Note files that can't be read. */
  broken: number
  checked: number
  filter: Filter
  groupMode: GroupMode
  showResolved: boolean
  isCheck(n: Note): boolean
  isHidden(n: Note): boolean
}

/** Every key's value now. */
export function notesContext(i: NotesCtxInput): Record<NotesCtxKey, boolean | string> {
  let listed = false, sessions = false, hidden = false
  for (const n of i.notes) {
    listed ||= !i.isCheck(n)
    sessions ||= !!n.data.session
    hidden ||= i.isHidden(n)
    if (listed && sessions && hidden) break
  }
  return {
    hasNotes: i.notes.length > 0 || i.broken > 0,
    listsNotes: listed || i.broken > 0,
    hasChecked: i.checked > 0,
    filtered: i.filter !== 'all',
    groupBy: i.groupMode,
    hasSessions: sessions,
    hasHiddenSessions: hidden,
    showResolved: i.showResolved,
  }
}
