// The episode in time: where the journey is at a second of the audio, where the audio goes when the reader moves the
// journey, its chapters, and the calmer views the player shows while it plays. Pure (test/podcastModel.test.ts).

import type { Chapter, Episode, Segment, View } from './format'

/** While playing, a view is held at least this long (s): a shorter part that would open another file doesn't. */
export const VIEW_HOLD_S = 8

/** Runs of segments on one step (or on the map); the first starts at 0, each ends where the next starts. */
export function chaptersOf(segments: Segment[], duration: number): Chapter[] {
  const out: Chapter[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (last && last.step === s.step) continue
    if (last) last.end = s.start
    out.push({ start: out.length ? s.start : 0, end: duration, step: s.step })
  }
  return out
}

/** The index of the segment playing at second `t`: the last one started by then (before the first: the first;
 *  between two: the one before the gap). -1: no segments. */
export function segmentAt(segments: { start: number }[], t: number): number {
  if (!segments.length) return -1
  let lo = 0, hi = segments.length - 1
  if (t < segments[0].start) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segments[mid].start <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Just the view of `v` (a segment, a view with more fields): its step, and its beat if it has one. */
export const ownView = (v: View): View => (v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat })

/** Where the journey should be at second `t` (any `t`: before the start, past the end), and the segment saying it. */
export function viewAt(ep: Episode, t: number): View & { seg: number } {
  const i = segmentAt(ep.segments, t)
  if (i < 0) return { seg: -1, step: 0 }
  return { seg: i, ...ownView(ep.segments[i]) }
}

export const sameView = (a: View | undefined, b: View | undefined) => !!a && !!b && a.step === b.step && a.beat === b.beat

/**
 * Where the audio goes when the reader moves the journey themselves: the first segment on step `step` (with `beat`:
 * the first on that beat). Undefined: the podcast says nothing there (a beat no segment names, a step it skips).
 */
export function timeOf(ep: Episode, step: number, beat?: number): number | undefined {
  const s = ep.segments.find((x) => x.step === step && (beat === undefined || x.beat === beat))
  return s?.start
}

/**
 * The start of the chapter before (dir -1) or after (dir 1) second `t`. ⏮ always goes to the part before, as the step
 * card's ‹ Previous goes to the step before: one meaning for "previous"; the first part's ⏮ is its start.
 */
export function chapterJump(ep: Episode, t: number, dir: 1 | -1): number {
  const cs = ep.chapters
  if (!cs.length) return dir > 0 ? ep.duration : 0
  const i = Math.max(0, cs.findIndex((c, k) => t >= c.start && (t < c.end || k === cs.length - 1)))
  if (dir > 0) return i + 1 < cs.length ? cs[i + 1].start : ep.duration
  return i === 0 ? cs[0].start : cs[i - 1].start
}

/** Consecutive items with the same key, as index ranges [from, to] (inclusive), in order. */
export function runsBy<T>(items: T[], key: (x: T) => string): { from: number; to: number; key: string }[] {
  const out: { from: number; to: number; key: string }[] = []
  items.forEach((x, k) => {
    const kx = key(x)
    const last = out[out.length - 1]
    if (last && last.key === kx) last.to = k
    else out.push({ from: k, to: k, key: kx })
  })
  return out
}

/**
 * The view each segment shows while the episode plays (by index): its own, except in a run of segments on one file
 * that lasts less than `hold` seconds (gaps included) and would switch the file shown: that run keeps the view before it
 * (it is coalesced into its neighbour), so the editor doesn't swap files for a three-second mention. Beats in the same
 * file move as written. The first run always shows. A seek shows the exact view at its time (viewAt), not this.
 * `fileOf`: the file a view shows ('' for the map).
 */
export function calmViews(ep: Episode, fileOf: (v: View) => string, hold = VIEW_HOLD_S): View[] {
  const segs = ep.segments
  const out: View[] = []
  for (const run of runsBy(segs, (s) => fileOf(ownView(s)))) {
    const next = segs[run.to + 1]
    const until = next ? next.start : Math.max(segs[run.to].end, ep.duration)
    const before = out[out.length - 1]
    // Short, and another file than the one on screen: held (the same file just moves the highlight).
    const held = before !== undefined && fileOf(before) !== run.key && until - segs[run.from].start < hold
    for (let x = run.from; x <= run.to; x++) out.push(held ? before : ownView(segs[x]))
  }
  return out
}
