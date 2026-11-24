// The order of a thread's rows: messages with the status changes where they happened, then the long thread's
// collapse ("Show N earlier replies", "Show fewer"). No vscode here: unit-tested in test/threadTimeline.test.ts.
import type { NoteEvent } from '../core/format/noteModel'
import { THREAD_LIMITS } from './limits'

export type TimelineEntry =
  | { kind: 'event'; event: NoteEvent; time?: number }
  /** `time`: its time when believed; `dated`: the stored date, shown instead when the clock was off. */
  | { kind: 'message'; index: number; time?: number; dated?: string }
  | { kind: 'showEarlier'; count: number }
  | { kind: 'showFewer' }

/** The replies a long thread hides: `from` up to before `to` (equal: none). */
export interface Hidden { from: number; to: number }

/**
 * The read replies between the first message and the last few; none while expanded, or when it would hide fewer than
 * two. `readUpTo`: messages before this index were read (when the visit started).
 */
export function hiddenReplies(total: number, readUpTo: number, expanded: boolean): Hidden {
  const from = 1
  if (total <= THREAD_LIMITS.collapseOver || expanded) return { from, to: from }
  const to = Math.min(total - THREAD_LIMITS.lastShown, readUpTo)
  return to - from < 2 ? { from, to: from } : { from, to }
}

const timeOf = (at: string | undefined) => (at ? Date.parse(at) : NaN)

type Merged = { kind: 'event'; event: NoteEvent } | { kind: 'message'; index: number }

/** Messages in order, each status change before the first message dated after it (the rest at the end). */
function byTime(messages: readonly { at?: string }[], events: readonly NoteEvent[]): Merged[] {
  const out: Merged[] = []
  let e = 0
  messages.forEach((m, index) => {
    const t = timeOf(m.at)
    if (!Number.isNaN(t)) for (; e < events.length && Date.parse(events[e].at) < t; e++) out.push({ kind: 'event', event: events[e] })
    out.push({ kind: 'message', index })
  })
  for (; e < events.length; e++) out.push({ kind: 'event', event: events[e] })
  return out
}

/** The rows in order: status changes, messages (hidden ones as one "Show N earlier replies"), "Show fewer" when a
 *  long thread is expanded. A message whose clock is off (future, or before the message above) keeps no time. */
export function timeline(
  messages: readonly { at?: string }[], events: readonly NoteEvent[], hidden: Hidden, expanded: boolean, now: number,
): TimelineEntry[] {
  const out: TimelineEntry[] = []
  const long = messages.length > THREAD_LIMITS.collapseOver
  let believed = 0
  for (const x of byTime(messages, events)) {
    if (x.kind === 'event') {
      const t = Date.parse(x.event.at)
      out.push({ kind: 'event', event: x.event, time: Number.isNaN(t) ? undefined : t })
      continue
    }
    const i = x.index
    if (i >= hidden.from && i < hidden.to) {
      if (i === hidden.from) out.push({ kind: 'showEarlier', count: hidden.to - hidden.from })
      continue
    }
    if (i === 1 && expanded && long) out.push({ kind: 'showFewer' })
    const at = messages[i].at
    const t = timeOf(at)
    if (Number.isNaN(t)) { out.push({ kind: 'message', index: i }); continue }
    const skewed = t > now + THREAD_LIMITS.skewMs || t < believed - THREAD_LIMITS.skewMs
    if (skewed) { out.push({ kind: 'message', index: i, dated: (at ?? '').slice(0, 10) }); continue }
    believed = Math.max(believed, t)
    out.push({ kind: 'message', index: i, time: t })
  }
  return out
}
