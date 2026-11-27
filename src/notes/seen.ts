// What the person has read: per note, how many of its messages and status changes they have seen; per journey, whether
// it was there when they last looked. Kept in the workspace state, out of the shared note and journey files, and in
// memory (read once, written through): unread() is asked per note on every change. Commands about reading (mark
// read or unread, the next unread note) are notes/unread.ts.

import { stored } from '../platform/host'
import { notesPorts } from './ports'
import { evMine, mine } from './identity'
import { LoadedJourney, posKey } from '../journeys/steps'
import { notesChanged } from './model'
import { Note } from './store'
import { STATE, StateKey } from '../platform/state'

/** A count per note id, kept in the workspace state under `key`, and in memory. */
class Counts {
  private cache: Record<string, number> | undefined
  constructor(private readonly key: StateKey<Record<string, number>>) {}
  all(): Readonly<Record<string, number>> { return (this.cache ??= { ...stored().get(this.key) }) }
  get(n: Note): number { return this.all()[n.data.id] ?? 0 }
  /** These counts set; the others kept. */
  async set(entries: [string, number][]): Promise<void> {
    if (!entries.length) return
    await this.replace({ ...this.all(), ...Object.fromEntries(entries) })
  }
  async replace(all: Record<string, number>): Promise<void> {
    this.cache = all
    await stored().set(this.key, all)
  }
  /** Read again from the workspace state (it was written elsewhere: a migration). */
  forget(): void { this.cache = undefined }
}

/** How many of each note's messages the person has seen. */
const seenMessages = new Counts(STATE.seenCount)
/** How many of each note's status changes the person has seen. */
const seenEvents = new Counts(STATE.seenEvents)

/** The stored state was migrated: read it again. */
export function reloadSeen(): void { seenMessages.forget(); seenEvents.forget() }

/** For the note being visited: messages from this index on keep their "new" label until the next note is opened. */
export const visitFrom = new Map<string, number>()

export const seenCount = (n: Note) => seenMessages.get(n)

/** Resolves the person hasn't seen, by someone else: a resolved note would otherwise vanish silently. (A reopen
 * by someone else needs no flag: the note is open and listed, and it usually comes with their reply.) */
function unreadEvents(n: Note): number {
  return (n.data.events ?? []).slice(seenEvents.get(n)).filter((e) => e.type === 'resolved' && !evMine(e)).length
}

/** Messages after the ones the person has seen, not written by them, and others' status changes. Independent of
 *  anyone's clock. */
export function unread(n: Note): number {
  const fresh = n.data.messages.slice(seenCount(n)).filter((m) => !mine(m)).length
  return fresh + unreadEvents(n)
}

/** These notes' seen counts set (and shown). */
export async function setSeen(entries: [string, number][]): Promise<void> {
  const saved = seenMessages.set(entries)
  if (entries.length) notesChanged({ kind: 'seen', ids: entries.map(([id]) => id) })
  await saved
}

/** Marks notes read; `visit` keeps this note's "new" labels for the visit. */
export async function markRead(list: Note[], visit?: Note): Promise<void> {
  const changes: [string, number][] = []
  const evChanges: [string, number][] = []
  for (const n of list) {
    const evs = n.data.events?.length ?? 0
    if (seenEvents.get(n) < evs) evChanges.push([n.data.id, evs])
    const was = seenCount(n)
    if (was >= n.data.messages.length) continue
    if (visit && n === visit && unread(n)) visitFrom.set(n.data.id, was)
    changes.push([n.data.id, n.data.messages.length])
  }
  // Both in memory at once, so the threads and the list follow now; storing them is waited for after.
  const saved = Promise.all([seenMessages.set(changes), seenEvents.set(evChanges)])
  notesChanged({ kind: 'seen', ids: list.map((n) => n.data.id) })
  await saved
}

/** What has been seen now (messages and status changes), to put back with `restoreSeen` (an undo). */
export const seenSnapshot = () => ({ messages: { ...seenMessages.all() }, events: { ...seenEvents.all() } })
export async function restoreSeen(before: ReturnType<typeof seenSnapshot>): Promise<void> {
  await Promise.all([seenMessages.replace(before.messages), seenEvents.replace(before.events)])
  notesChanged({ kind: 'seen' })
}

function seenJourneys(): Set<string> | undefined {
  const v = stored().get(STATE.journeysSeen)
  return v ? new Set(v) : undefined
}

export function isNewJourney(lj: LoadedJourney): boolean {
  const seen = seenJourneys()
  return !!seen && !seen.has(posKey(lj))
}

/** The first time: every journey there now counts as seen. After that, `only` (opened) is no longer new. */
export async function markJourneysSeen(only?: LoadedJourney): Promise<void> {
  const seen = seenJourneys()
  if (!seen) {
    await stored().set(STATE.journeysSeen, notesPorts().journeys.all().map(posKey))
    return
  }
  if (!only || seen.has(posKey(only))) return
  seen.add(posKey(only))
  await stored().set(STATE.journeysSeen, [...seen])
}
