// The chord keys: Ctrl+' (or Ctrl+<) then C/R/D/A/V. D/A walk the steps while a tour runs, a check's open questions
// while it has some, else unread replies.

import { gstate, KEY, mapPanel, notes, PREFIX_KEY, setKey, understanding } from './app'
import { resolve } from './notes/status'
import { stepUnread } from './notes/unread'
import { pickNotes } from './notes/which'
import { unread } from './seen'
import { walk } from './tour/tour'
import { checkStepping } from './check/wiring'

/** A chord key passes which prefix was pressed: hints then show that one. */
export const prefixUsed = (a: unknown) => {
  const p = a && typeof a === 'object' ? (a as { prefix?: string }).prefix : undefined
  if (p !== "'" && p !== '<') return
  const k = `Ctrl+${p}`
  if (k === KEY) return
  setKey(k)
  void gstate.update(PREFIX_KEY, k)
  walk.updateTour()
  mapPanel.update()
}

/** D: the next step while a tour runs; else the next open question of a check; else the next unread reply. */
export const next = (a?: unknown) => {
  prefixUsed(a)
  if (walk.touring()) return walk.stepBy(1)
  // Questions of a check still open: D goes to the next one (unread replies wait until the check is done).
  if (checkStepping()) return understanding!.step(1)
  // No tour: D is the next unread reply, as the status bar says; resuming is the map's ▶ Resume.
  return stepUnread(1)
}

/** A: back, as D goes on. */
export const previous = (a?: unknown) => {
  prefixUsed(a)
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
