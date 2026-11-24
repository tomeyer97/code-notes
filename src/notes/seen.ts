// What the person has read: per note, how many of its messages and status changes they have seen; per journey, whether
// it was there when they last looked. Kept in the workspace state, out of the shared note and journey files.

import { journeys, stored } from '../app'
import { evMine, mine } from './identity'
import { LoadedJourney, posKey } from '../journeys/steps'
import { refreshAll } from '../refresh'
import { Note } from './store'
import { STATE, StateKey } from '../platform/state'

/** A count per note id, kept in the workspace state under `key`. */
function countStore(key: StateKey<Record<string, number>>) {
  const all = (): Record<string, number> => stored.get(key)
  return {
    all,
    get: (n: Note): number => all()[n.data.id] ?? 0,
    /** These counts set; the others kept. */
    set: async (entries: [string, number][]): Promise<void> => {
      if (!entries.length) return
      await stored.set(key, { ...all(), ...Object.fromEntries(entries) })
    },
  }
}

/** How many of each note's messages the person has seen. */
const seenMessages = countStore(STATE.seenCount)
/** How many of each note's status changes the person has seen. */
const seenEvents = countStore(STATE.seenEvents)

/** For the note being visited: messages from this index on keep their "new" label until the next note is opened. */
export const visitFrom = new Map<string, number>()

export const seenCount = seenMessages.get

/** Resolves the person hasn't seen, by someone else: a resolved note would otherwise vanish silently. (A reopen
 * by someone else needs no flag: the note is open and listed, and it usually comes with their reply.) */
function unreadEvents(n: Note): number {
  return (n.data.events ?? []).slice(seenEvents.get(n)).filter((e) => e.type === 'resolved' && !evMine(e)).length
}

/** Messages after the ones the person has seen, not written by them, and others' status changes. Independent of anyone's clock. */
export function unread(n: Note): number { return n.data.messages.slice(seenCount(n)).filter((m) => !mine(m)).length + unreadEvents(n) }

export const setSeen = seenMessages.set

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
  // Both stored at once; what is read back is in memory already, so the threads and the list follow at once.
  const saved = Promise.all([seenMessages.set(changes), seenEvents.set(evChanges)])
  refreshAll()
  await saved
}

/** What has been seen now (messages and status changes), to put back with `restoreSeen` (an undo). */
export const seenSnapshot = () => ({ messages: { ...seenMessages.all() }, events: { ...seenEvents.all() } })
export const restoreSeen = async (before: ReturnType<typeof seenSnapshot>): Promise<void> => {
  await Promise.all([stored.set(STATE.seenCount, before.messages), stored.set(STATE.seenEvents, before.events)])
}

function seenJourneys(): Set<string> | undefined {
  const v = stored.get(STATE.journeysSeen)
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
    await stored.set(STATE.journeysSeen, journeys.all().map(posKey))
    return
  }
  if (!only || seen.has(posKey(only))) return
  seen.add(posKey(only))
  await stored.set(STATE.journeysSeen, [...seen])
}
