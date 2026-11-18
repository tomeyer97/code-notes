// Note files changed on disk by someone else (an agent replied, resolved, or added a note; git): what changed is
// recorded, then everything refreshed and the notes re-anchored.

import { log, notes, store } from '../app'
import { isAgent, mine } from '../identity'
import { Message, NoteEvent } from '../noteModel'
import { refreshAll } from '../refresh'
import { lastMessage } from '../sidebar/nodes'
import { Note } from '../store'
import { card, tourState, walk } from '../tour/instances'
import { reanchorAll } from './location'
import { addEvent, statusEvent } from './status'

/** What a note looked like on disk: its message count, status and number of status changes. */
type Shape = { count: number; status: string; events: number }

/** Each note's shape as last seen from disk, to notice replies on resolved notes. */
export const shape = new Map<string, Shape>()

export const shapeOf = (n: Note): Shape => ({ count: n.data.messages.length, status: n.data.status, events: n.data.events?.length ?? 0 })

/** Whether the notes were read once: changes on disk are told apart from then on. */
let loaded = false

/** The notes were read: what they are now is what later changes on disk are compared with. */
export function followNotesOnDisk(): void {
  for (const n of notes()) shape.set(n.data.id, shapeOf(n))
  loaded = true
}

let reanchorTimer: NodeJS.Timeout | undefined

/** After a burst of changes on disk, the notes are re-anchored once. */
const REANCHOR_AFTER_MS = 200

/** Notes changed on disk (an agent replied, resolved, or added a note): each note's rule, then everything refreshed. */
export async function notesChangedOnDisk(): Promise<void> {
  for (const n of notes()) await noteChangedOnDisk(n)
  refreshAll()
  // A question on the current step was asked or answered: the card says so.
  const tj = walk.touring() ? walk.tourJourney() : undefined
  if (tj && !card.inMap(tj, tourState.step)) card.show(tj, tourState.step)
  clearTimeout(reanchorTimer)
  reanchorTimer = setTimeout(() => reanchorAll().then(refreshAll), REANCHOR_AFTER_MS)
}

/**
 * Someone else's reply reopens a resolved note. A status changed on disk without saying so in "events" is recorded, as
 * theirs, so it shows as new; not when the file lost events (an older version restored: git checkout, undo), nor twice
 * in a row for the same change.
 */
async function noteChangedOnDisk(n: Note): Promise<void> {
  const prev = shape.get(n.data.id)
  if (loaded && prev) await statusChangedOnDisk(n, prev)
  shape.set(n.data.id, shapeOf(n))
}

/** A status change by the author of message `m` (someone, when there is none). */
const addEventOf = (n: Note, type: NoteEvent['type'], m: Message | undefined) =>
  addEvent(n, type, m?.author ?? 'someone', m && isAgent(m) ? 'agent' : undefined)

async function statusChangedOnDisk(n: Note, prev: Shape): Promise<void> {
  const count = n.data.messages.length
  const replied = count > prev.count && n.data.messages.slice(prev.count).some((m) => !mine(m))
  if (prev.status === 'resolved' && n.data.status === 'resolved' && replied) {
    n.data.status = 'open'
    addEventOf(n, 'reopened', lastMessage(n))
    log.appendLine(`note ${n.data.id}: reopened by a reply from ${lastMessage(n)?.author}`)
    await store.save(n)
  } else if (prev.status !== n.data.status) {
    log.info(`note ${n.data.id}: ${n.data.status} on disk (by someone else)`)
    const evs = n.data.events ?? []
    const type = statusEvent(n.data.status)
    if (evs.length === prev.events && evs[evs.length - 1]?.type !== type) {
      addEventOf(n, type, [...n.data.messages].reverse().find((m) => !mine(m)))
      await store.save(n)
    }
  }
}
