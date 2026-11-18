// Where a podcast goes on from: after the walk moved to a step it skips, when it is played again, when its file was
// rewritten. Pure (no vscode): unit tests use it as is (test/podcastResume.test.ts); player.ts applies it.

import { Episode, segmentAt, timeOf, viewAt } from './model'

/**
 * The walk is on step `step`, which the podcast never talks about: where ▶ goes on. The first part about a later
 * step; else (no step after it is covered) the part after the last one about an earlier step (the recap); else
 * undefined (nothing after it: ▶ plays from where the audio is).
 */
export function afterStep(ep: Episode, step: number): number | undefined {
  const later = ep.segments.find((s) => s.step > step)
  if (later) return later.start
  let last = -1
  ep.segments.forEach((s, i) => { if (s.step && s.step < step) last = i })
  return last >= 0 && last + 1 < ep.segments.length ? ep.segments[last + 1].start : undefined
}

/**
 * Where ▶ starts a podcast that isn't playing in the panel: where it was left (`saved`), unless the walk is on a step
 * (`walkStep`, 0: none) that time isn't about; then the first part about that step, or, a step it skips, the part
 * after it (afterStep).
 */
export function resumeTime(ep: Episode, saved: number, walkStep: number): number {
  const t = Math.max(0, Math.min(saved, ep.duration))
  if (!walkStep || viewAt(ep, t).step === walkStep) return t
  return timeOf(ep, walkStep) ?? afterStep(ep, walkStep) ?? t
}

/**
 * The podcast file was rewritten while at second `t` of `from`: the same moment in `to`. Times unchanged: `t`. The
 * segment playing then moved: the same place in that segment (by id), kept inside it; it is gone: `t`, kept inside the
 * episode.
 */
export function remapTime(from: Episode, to: Episode, t: number): number {
  const i = segmentAt(from.segments, t)
  const clamp = (x: number) => Math.max(0, Math.min(x, to.duration))
  if (i < 0) return clamp(t)
  const was = from.segments[i]
  const now = to.segments.find((s) => s.id === was.id)
  if (!now) return clamp(t)
  if (now.start === was.start) return clamp(t)
  const into = Math.max(0, t - was.start)
  return clamp(Math.min(now.start + into, Math.max(now.start, now.end - 0.05)))
}
