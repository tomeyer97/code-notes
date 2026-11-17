// What the person has read: per note, how many of its messages and status changes they have seen; per journey, whether
// it was there when they last looked. Kept in the workspace state, out of the shared note and journey files.

import { journeys, notes, state } from './app'
import { evMine, mine } from './identity'
import { LoadedJourney, posKey } from './journeys/steps'
import { refreshAll } from './refresh'
import { Note } from './store'

const SEEN_KEY = 'codeNotes.seenCount' // note id -> how many of its messages the person has seen
const SEEN_EV_KEY = 'codeNotes.seenEvents' // note id -> how many of its status changes the person has seen
const OLD_SEEN_KEY = 'codeNotes.seen' // v0.1: note id -> ISO time (migrated)

/** For the note being visited: messages from this index on keep their "new" label until the next note is opened. */
export const visitFrom = new Map<string, number>()

function seenMap(): Record<string, number> { return state.get<Record<string, number>>(SEEN_KEY) ?? {} }
export function seenCount(n: Note): number { return seenMap()[n.data.id] ?? 0 }
function seenEvMap(): Record<string, number> { return state.get<Record<string, number>>(SEEN_EV_KEY) ?? {} }
function seenEvents(n: Note): number { return seenEvMap()[n.data.id] ?? 0 }

/** Resolves the person hasn't seen, by someone else: a resolved note would otherwise vanish silently. (A reopen
 * by someone else needs no flag: the note is open and listed, and it usually comes with their reply.) */
function unreadEvents(n: Note): number { return (n.data.events ?? []).slice(seenEvents(n)).filter((e) => e.type === 'resolved' && !evMine(e)).length }

/** Messages after the ones the person has seen, not written by them, and others' status changes. Independent of anyone's clock. */
export function unread(n: Note): number { return n.data.messages.slice(seenCount(n)).filter((m) => !mine(m)).length + unreadEvents(n) }

export async function setSeen(entries: [string, number][]): Promise<void> {
  if (!entries.length) return
  await state.update(SEEN_KEY, { ...seenMap(), ...Object.fromEntries(entries) })
}

async function setSeenEvents(entries: [string, number][]): Promise<void> {
  if (!entries.length) return
  await state.update(SEEN_EV_KEY, { ...seenEvMap(), ...Object.fromEntries(entries) })
}

/** Marks notes read; `visit` keeps this note's "new" labels for the visit. */
export async function markRead(list: Note[], visit?: Note): Promise<void> {
  const changes: [string, number][] = []
  const evChanges: [string, number][] = []
  for (const n of list) {
    const evs = n.data.events?.length ?? 0
    if (seenEvents(n) < evs) evChanges.push([n.data.id, evs])
    const was = seenCount(n)
    if (was >= n.data.messages.length) continue
    if (visit && n === visit && unread(n)) visitFrom.set(n.data.id, was)
    changes.push([n.data.id, n.data.messages.length])
  }
  // Both stored at once; what is read back is in memory already, so the threads and the list follow at once.
  const saved = Promise.all([setSeen(changes), setSeenEvents(evChanges)])
  refreshAll()
  await saved
}

/** What `seenMap` holds now, to put back with `restoreSeen` (an undo). */
export const seenSnapshot = () => ({ ...seenMap() })
export const restoreSeen = (before: Record<string, number>) => state.update(SEEN_KEY, before)

/** v0.1 stored a time per note: now a count of messages seen. */
export async function migrateSeen(): Promise<void> {
  const old = state.get<Record<string, string>>(OLD_SEEN_KEY)
  if (!old) return
  const changes: [string, number][] = []
  for (const n of notes()) {
    const at = Date.parse(old[n.data.id] ?? '')
    if (!at || seenMap()[n.data.id] !== undefined) continue
    let count = 0
    for (const m of n.data.messages) { if ((Date.parse(m.at ?? '') || 0) <= at) count++; else break }
    changes.push([n.data.id, count])
  }
  await setSeen(changes)
  await state.update(OLD_SEEN_KEY, undefined)
}

/** Journeys seen in the list (posKeys); one added since is "new" until opened (R1). Unset: everything there now is known. */
const SEEN_J_KEY = 'codeNotes.journeysSeen'

function seenJourneys(): Set<string> | undefined {
  const v = state.get<string[]>(SEEN_J_KEY)
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
    await state.update(SEEN_J_KEY, journeys.all().map(posKey))
    return
  }
  if (!only || seen.has(posKey(only))) return
  seen.add(posKey(only))
  await state.update(SEEN_J_KEY, [...seen])
}
