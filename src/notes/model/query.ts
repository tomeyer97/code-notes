// Which notes the Code Notes view lists and how: the filter, resolved notes shown or not, hidden sessions, grouping by
// file or by session, and the order of notes. Pure: what a note's thread or read state says comes in as NoteFacts.

import type { Message } from '../../core/format/noteModel'
import type { Note } from '../store'

/** What the Code Notes view lists (the picker: FILTERS). Who spoke last is each row's icon, not a filter. */
export type Filter = 'all' | 'unread' | 'stale'

export const FILTERS: { id: Filter; label: string; detail: string }[] = [
  { id: 'all', label: 'All notes', detail: 'Open notes (and resolved ones when shown)' },
  { id: 'unread', label: 'Unread', detail: 'Notes with replies you have not seen' },
  { id: 'stale', label: 'Stale', detail: 'The code under the note changed' },
]

export type GroupMode = 'file' | 'session'

/** A note's session; '' for the notes without one. */
export const sessionOf = (n: Note) => n.data.session ?? ''

export const lastMessage = (n: Note): Message | undefined => n.data.messages[n.data.messages.length - 1]

/** By line, then by when written (the id when there is no time). */
export const order = (a: Note, b: Note) =>
  a.data.range.start - b.data.range.start || (a.data.createdAt ?? a.data.id).localeCompare(b.data.createdAt ?? b.data.id)

/** What the query asks about a note beyond its data. */
export interface NoteFacts {
  /** A question of the understanding check: listed in the Check view, not in Code Notes. */
  isCheck(n: Note): boolean
  /** How many of its messages and status changes the person has not seen. */
  unread(n: Note): number
  /** The note the person just opened (shown even when its filter or session would hide it). */
  revealed(): string | undefined
  /** The sessions hidden in the editor. */
  hiddenSessions(): ReadonlySet<string>
  /** The notes shown (another branch's check questions left out). */
  notes(): Note[]
}

export class NotesQuery {
  filter: Filter = 'all'
  showResolved = false
  groupMode: GroupMode = 'file'

  constructor(private readonly facts: NoteFacts) {}

  /** The note is listed under the view's filter. */
  matches(n: Note): boolean { return this.listedUnder(n, this.filter) }

  /** The note is listed under filter `f`. */
  listedUnder(n: Note, f: Filter): boolean {
    // A check's questions are listed in the Check view, not here as well.
    if (this.facts.isCheck(n)) return false
    const open = n.data.status === 'open'
    switch (f) {
      case 'unread': return this.facts.unread(n) > 0 || this.facts.revealed() === n.data.id
      case 'stale': return !!n.data.stale && (open || this.showResolved)
      default: return open || this.showResolved || this.facts.unread(n) > 0
    }
  }

  /** How many notes filter `f` lists. */
  count(f: Filter): number { return this.facts.notes().filter((n) => this.listedUnder(n, f)).length }

  isHidden(n: Note): boolean { return this.facts.hiddenSessions().has(sessionOf(n)) }

  /** A note whose session is hidden is not drawn in the editor (unless it was just opened from the list). */
  hiddenInEditor(n: Note): boolean { return this.facts.revealed() !== n.data.id && this.isHidden(n) }

  /** Grouped by session: when there are sessions and the person chose it. */
  bySessions(): boolean { return this.groupMode === 'session' && this.facts.notes().some((x) => x.data.session) }

  /** The session group a note is listed under, if any. */
  scopeOf(n: Note): string | undefined { return this.bySessions() ? sessionOf(n) : undefined }
}
