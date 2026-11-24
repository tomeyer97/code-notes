// The chord keys: Ctrl+' (or Ctrl+<) then C/R/D/A/V. D/A walk the steps while a tour runs, a check's open questions
// while it has some, else unread replies.

import { KEY, mapPanel, notes, setKey, stored, understanding } from './app'
import { resolve } from './notes/status'
import { stepUnread } from './notes/unread'
import { pickNotes } from './notes/which'
import { unread } from './notes/seen'
import { checkStepping } from './check/wiring'
import { walk } from './tour/instances'
import { fireAndForget } from './platform/run'
import { STATE } from './platform/state'

/** A chord key passes which prefix was pressed: hints then show that one. */
export const prefixUsed = (a: unknown) => {
  const p = a && typeof a === 'object' ? (a as { prefix?: string }).prefix : undefined
  if (p !== "'" && p !== '<') return
  const k = `Ctrl+${p}`
  if (k === KEY) return
  setKey(k)
  fireAndForget(stored.set(STATE.chordPrefix, k), 'chords: store chordPrefix')
  walk.updateTour()
  mapPanel.update()
}

/** D: the next step while a tour runs (a podcast playing, or on its Intro or Recap: its next part); else the next open
 *  question of a check; else the next unread reply. */
export const next = (a?: unknown) => {
  prefixUsed(a)
  // A podcast on the map's parts (Intro, Recap) or playing: D is its ⏭ (one transport, F85).
  if (walk.transport?.(1)) return
  if (walk.touring()) return walk.stepBy(1)
  // Questions of a check still open: D goes to the next one (unread replies wait until the check is done).
  if (checkStepping()) return understanding!.step(1)
  // No tour: D is the next unread reply, as the status bar says; resuming is the map's ▶ Resume.
  return stepUnread(1)
}

/** A: back, as D goes on. */
export const previous = (a?: unknown) => {
  prefixUsed(a)
  if (walk.transport?.(-1)) return
  if (walk.touring()) return walk.stepBy(-1)
  if (checkStepping()) return understanding!.step(-1)
  return stepUnread(-1)
}

/** R: resolve the note at the cursor, then on to the next unread one. */
export const resolveNext = async (a?: unknown) => {
  prefixUsed(a)
  const list = await pickNotes(undefined)
  if (!list.length) return
  await resolve(list)
  if (notes().some((n) => unread(n) > 0)) await stepUnread(1)
}
