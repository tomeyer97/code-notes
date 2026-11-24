// A podcast against its journey: the episode the player plays. Each segment gets its time, its text and the view it
// shows; what can't be followed as written becomes a problem on the segment. Pure.

import {
  beatsItHas, Episode, IndexedSegment, Podcast, PodcastProblem, Segment, segmentEnd, segProblem, Sentence, sentenceBound,
  sentencesProblem, startOf, stepProblem, View,
} from './format'
import { isObj, num } from './guards'
import { JourneyShape, stepAt, StepIndex, stepIndex } from './journeyShape'
import { marksOf } from './marks'
import { chaptersOf } from './timeline'

/** A segment with a usable start, and its index in the list it came from. */
export interface TimedSegment extends IndexedSegment { start: number }

/** The segments with a usable start, in time order (file order for the same start). */
export function timedSegments(written: IndexedSegment[]): TimedSegment[] {
  const out: TimedSegment[] = []
  for (const x of written) {
    const start = startOf(x.s)
    if (start !== undefined) out.push({ ...x, start })
  }
  return out.sort((a, b) => a.start - b.start || a.i - b.i)
}

/** Why a segment has no usable start (it is skipped). */
export const noStart = (s: { start?: unknown }) =>
  `${s.start === undefined ? 'no start time' : `start ${JSON.stringify(s.start)} is not a time in seconds`}; skipped`

/**
 * The podcast against its journey. Each segment's `at` becomes a view; one the journey can't show degrades instead
 * of breaking the episode: a beat the step doesn't have (beats are linked by position) shows the step only; an
 * unknown step, or an `at` that isn't one, keeps the view of the segment before it. `cue: "map"` on a step shows the
 * step without its animation. Segments without a usable start are dropped; a missing end is the next one's start.
 * Problems point at `p.segments` by index.
 */
export function resolveEpisode(p: Podcast, journey: JourneyShape): Episode {
  const problems: PodcastProblem[] = []
  const indexed = p.segments.map((s, i) => ({ s, i }))
  for (const { s, i } of indexed) {
    if (startOf(s) === undefined) problems.push(segProblem(s, i, 'start', noStart(s), ['start']))
  }
  const timed = timedSegments(indexed)
  const steps = stepIndex(journey)
  let prev: View = { step: 0 }
  const segments = timed.map((x, k) => {
    const view = viewOf(x, steps, prev, problems)
    prev = view
    return segmentOf(x, view, timed[k + 1]?.start, p.duration, journey)
  })
  const last = segments[segments.length - 1]
  const duration = Math.max(num(p.duration) ?? 0, last ? last.end : 0)
  return { title: p.title, duration, segments, chapters: chaptersOf(segments, duration), problems }
}

/** One timed segment as the player has it; `next`: the next segment's start. */
function segmentOf(x: TimedSegment, view: View, next: number | undefined, duration: number | undefined, journey: JourneyShape): Segment {
  const { s, i, start } = x
  const stepId = view.step ? journey.steps[view.step - 1]?.id : undefined
  const seg: Segment = {
    id: typeof s.id === 'string' ? s.id : `#${i + 1}`,
    start,
    end: segmentEnd(s, start, next, duration),
    text: typeof s.text === 'string' ? s.text : '',
    speaker: typeof s.speaker === 'string' ? s.speaker : '',
    ...view,
    ...(stepId ? { stepId } : {}),
  }
  // Sentence times are all or nothing: one bad item and the player estimates them all (validate.ts says why).
  if (s.sentences !== undefined && !sentencesProblem(s.sentences, start, sentenceBound(s, start, next, duration))) {
    seg.sentences = (s.sentences as Sentence[]).map((t) => ({ start: t.start, text: t.text }))
  }
  const marks = marksOf(s.marks, seg.text, seg.start, seg.end, s.at === null)
  if (marks) seg.marks = marks
  return seg
}

/** One segment's view (see resolveEpisode); `prev`: the view before it. */
function viewOf({ s, i }: IndexedSegment, steps: StepIndex, prev: View, problems: PodcastProblem[]): View {
  if (s.at === null) return { step: 0 }
  if (!isObj(s.at) || typeof s.at.step !== 'string') {
    const what = `"at" is ${s.at === undefined ? 'missing' : 'not null or { step, beat }'}; it keeps the view before it`
    problems.push(segProblem(s, i, 'at', what, s.at === undefined ? [] : ['at']))
    return prev
  }
  const at = stepAt(s, steps)
  if (!at) {
    problems.push(segProblem(s, i, 'step', `no step "${s.at.step}" in the journey; it keeps the view before it`, ['at', 'step']))
    return prev
  }
  const { n, beats } = at.step
  const b = at.beat
  if (b === undefined || s.cue === 'map') return { step: n }
  // A beat written as a string ("2") is not beat 2: said as what it is, not as a beat the step lacks.
  if (typeof b === 'string') {
    problems.push(stepProblem(s, i, n, 'beat', `beat must be a number, got the string ${JSON.stringify(b)}; showing the whole step`, ['at', 'beat']))
    return { step: n }
  }
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > beats) {
    problems.push(stepProblem(s, i, n, 'beat', `no beat ${JSON.stringify(b)} (${beatsItHas(beats)}); showing the whole step`, ['at', 'beat']))
    return { step: n }
  }
  return { step: n, beat: b - 1 }
}
