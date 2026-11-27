// Short texts of the Code Notes rows that follow rules worth testing. No vscode here.
import type { Note } from '../notes/store'
import type { Message, NoteEvent } from '../core/format/noteModel'
import { baseName } from '../core/paths'
import { plural, rangeLabel } from '../core/text'

/** A group row's counts, each with its noun: `2 notes`, `1 new` (notes with something unread). */
export const groupCounts = (notes: number, unread: number): string[] => [plural(notes, 'note'), unread ? `${unread} new` : '']

/** Messages after the `seen` first ones, not the person's own: a note row's "n new" (a resolve is not a message). */
export const unreadMessages = (n: Note, seen: number, mine: (m: Message) => boolean): number =>
  n.data.messages.slice(seen).filter((m) => !mine(m)).length

/** A resolved note's state: "resolved by X" when someone else resolved it last, else "resolved". */
export function resolvedLabel(n: Note, mine: (e: NoteEvent) => boolean): string {
  const ev = [...(n.data.events ?? [])].reverse().find((e) => e.type === 'resolved')
  return ev && !mine(ev) ? `resolved by ${ev.by}` : 'resolved'
}

/** Where a note's row says it is. Under a file row its lines (`L12`); elsewhere (in a session, in the Journeys view)
 *  the row names the file: `app.ts:12`, a whole-file note `app.ts`, a folder note `src/`. */
export function whereLabel(n: Note, alone: boolean): string {
  if (!alone) return rangeLabel(n)
  const base = baseName(n.data.file)
  if (n.data.target === 'folder') return `${base}/`
  if (n.data.target) return base
  return `${base}:${n.data.range.start}`
}

/** Folders shown in a file row's description, the last ones ("…/api/v2"). */
const DIRS_SHOWN = 2

/** A file's folder as its row shows it: `src/api`, or its last folders (`…/api/v2`); '' at the top. */
export function shortDir(file: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const segs = dir.split('/').filter(Boolean)
  return segs.length > DIRS_SHOWN ? `…/${segs.slice(-DIRS_SHOWN).join('/')}` : dir
}
