// A journey's podcast (docs/podcast-format.md): one audio file whose parts are linked to the journey's steps and
// animation beats. This file holds the format's types and the per-segment rules the reader and the full check share;
// resolve.ts turns a file into the episode the player plays, timeline.ts answers "where is the journey at this
// second", marks.ts reads a segment's marks, validate.ts is the full check. No vscode here.

import type { CodeMark, MarkProblem } from '../marks'
import { clockMs } from '../../clock'
import { isObj, num, Path, TIME_SLACK_S } from './guards'

/** Where a segment belongs in the journey, as written: null (the whole journey: the map), or a step by id, with the
 *  1-based position of a beat in that step's `scene.beats`. */
export type WrittenAt = null | { step: string; beat?: number }

/** What a problem is about: one name per rule (the Problems view shows it; journey.py and the tests match on it). */
export type ProblemCode =
  // The file: not JSON, not a podcast, its audio, its list of segments.
  | 'json' | 'object' | 'version' | 'audio' | 'audio-outside' | 'audio-missing' | 'audio-empty' | 'segments'
  // File-level warnings, and the quiet note about code changed since recording.
  | 'journey' | 'duration' | 'audio-short' | 'recorded-for'
  // A segment's own fields and times.
  | 'segment' | 'id' | 'cue' | 'start' | 'end' | 'end-before-start' | 'order' | 'past-duration' | 'past-audio'
  | 'overlap' | 'sentences' | 'mark'
  // A segment's link to the journey.
  | 'at' | 'step' | 'beat' | 'narration-order'

/** Something wrong with a podcast file (validate.ts). `error`: it can't be played; `warning`: it plays, but a part of
 *  it is not what the file says; `info`: worth knowing, nothing wrong with the file (recorded for an older commit).
 *  `path`: where in the file (JSON keys and indexes); `segment`: the segment's id. */
export interface PodcastProblem {
  level: 'error' | 'warning' | 'info'
  code: ProblemCode
  message: string
  path: Path
  segment?: string
  /** A problem said once for several segments (a step the journey doesn't have): every one of them. */
  segments?: string[]
}

/** A problem within one segment, before it is said on the segment: what is wrong, and where within the segment. The
 *  marks' problems (MarkProblem: which mark, and whether it is dropped) are this too. */
export type SegmentIssue = Pick<MarkProblem, 'what' | 'sub'>

/** A segment as written in the file. Other fields (e.g. `say`, the spoken form a generator used) are allowed and
 *  ignored. */
export interface WrittenSegment {
  id?: string
  at?: unknown
  cue?: unknown
  speaker?: unknown
  text?: unknown
  start?: unknown
  end?: unknown
  /** When each sentence of `text` starts in the audio (e.g. a text-to-speech service's alignment): [{ start, text }]. */
  sentences?: unknown
  /** Highlights lit while the voice says a phrase (docs/podcast-format.md, "Marks"): [{ phrase, at, lines, … }]. */
  marks?: unknown
}

/** A written segment and its index in the file's `segments` (problems point there). */
export interface IndexedSegment { s: WrittenSegment; i: number }

/** The podcast file, checked for its shape only (validate.ts readPodcastText). */
export interface Podcast {
  version: number
  title: string
  journey: { id: string; file?: string; commit?: string }
  /** The audio file, relative to the podcast file. */
  audio: string
  duration?: number
  segments: WrittenSegment[]
}

/** Where the journey is: on a step (1-based; 0: no step, the map) and, on a step, a beat of its animation (0-based;
 *  undefined: the step without its animation). */
export interface View { step: number; beat?: number }

/** A highlight that lights while the voice says `phrase`: a code mark (core/format/marks.ts) whose `file` defaults to the
 *  segment's beat's file, else its step's. */
export interface Mark extends CodeMark {
  phrase: string
  /** Seconds from the segment's start: when the phrase's first character is said. */
  at: number
}

/** A segment as the player uses it: its time, its text, and the view it shows. */
export interface Segment extends View {
  id: string
  /** The id of its step (a journey edited under the podcast keeps the step, not its number). */
  stepId?: string
  start: number
  end: number
  text: string
  speaker: string
  /** When each sentence starts, as written (only when they are all usable: sentencesProblem). Undefined: the player
   *  estimates the sentence times from the text. */
  sentences?: Sentence[]
  /** Its usable marks, in the order they light (marksOf). */
  marks?: Mark[]
}

/** A sentence of a segment's text and the second of the audio it starts at: the caption shown from then on. */
export interface Sentence { start: number; text: string }

/** A run of segments on the same step (or on the map): what the timeline marks. */
export interface Chapter { start: number; end: number; step: number }

/** A podcast resolved against its journey: every segment's view, in time order, and what could not be followed (an
 *  unknown step, a beat the step does not have, …) with the segment and where it is in the file. */
export interface Episode {
  title: string
  duration: number
  segments: Segment[]
  chapters: Chapter[]
  problems: PodcastProblem[]
}

/** The podcast file next to a journey file: `x.json` → `x.podcast.json`. */
export const podcastFileOf = (journeyPath: string) => journeyPath.replace(/\.json$/i, '') + '.podcast.json'
/** A podcast file is never read as a journey. */
export const isPodcastFile = (name: string) => /\.podcast\.json$/i.test(name)

/** The name a segment goes by in messages: its id, else its place in the file (1-based). */
export const segmentName = (s: WrittenSegment, i: number) => (typeof s.id === 'string' && s.id ? s.id : `#${i + 1}`)

/** A warning about segment `i` (index in the file) at `sub` (keys within it). */
export function segProblem(s: WrittenSegment, i: number, code: ProblemCode, what: string, sub: Path = []): PodcastProblem {
  const name = segmentName(s, i)
  return { level: 'warning', code, message: `segment ${name}: ${what}`, path: ['segments', i, ...sub], segment: name }
}

/** A warning about segment `i` said by the step it is on, as the reader sees it ("Step 3: …"): no segment name. */
export function stepProblem(s: WrittenSegment, i: number, n: number, code: ProblemCode, what: string, sub: Path = []): PodcastProblem {
  return { ...segProblem(s, i, code, what, sub), message: `Step ${n}: ${what}` }
}

/** "it has 5", "it has none": how many beats a step has, in a message. */
export const beatsItHas = (n: number) => `it has ${n || 'none'}`

/** Codes of the problems that are a link the journey can't show (a part that can't be shown as written). */
export const LINK_CODES: ReadonlySet<ProblemCode> = new Set<ProblemCode>(['at', 'step', 'beat'])

/** A segment's start in seconds, when it has a usable one (a number, not negative). */
export function startOf(s: WrittenSegment): number | undefined {
  const t = num(s.start)
  return t !== undefined && t >= 0 ? t : undefined
}

/** The latest a segment's sentence may start: its end as written, else the next segment's start, else the episode's
 *  duration; undefined when none is known (the last segment of a file without "duration": no limit). */
export function sentenceBound(s: WrittenSegment, start: number, next: number | undefined, duration: number | undefined): number | undefined {
  const end = num(s.end) ?? next ?? num(duration)
  return end === undefined ? undefined : Math.max(end, start)
}

/** A segment's end as the player times it: sentenceBound, else its start (a part of no length). */
export const segmentEnd = (s: WrittenSegment, start: number, next: number | undefined, duration: number | undefined) =>
  sentenceBound(s, start, next, duration) ?? start

const notSentences = (v: unknown): SegmentIssue => ({
  what: Array.isArray(v) ? 'sentences is empty' : 'sentences is not a list of { start, text }',
  sub: ['sentences'],
})

/**
 * What is wrong with a segment's `sentences` (undefined: they can be used): not a non-empty list of { start, text },
 * starts not in order, or a start outside the segment (`start` to `end`; no end: from `start` on).
 */
export function sentencesProblem(v: unknown, start: number, end: number | undefined): SegmentIssue | undefined {
  if (!Array.isArray(v) || !v.length) return notSentences(v)
  let prev: number | undefined
  for (const [k, t] of v.entries()) {
    const item = `sentences: item ${k + 1}`
    if (!isObj(t) || typeof t.text !== 'string' || !t.text.trim()) {
      return { what: `${item} is not { start, text } with a text`, sub: ['sentences', k] }
    }
    const at = num(t.start)
    const sub = ['sentences', k, 'start']
    if (at === undefined) return { what: `${item} has no start time in seconds`, sub }
    if (prev !== undefined && at < prev - TIME_SLACK_S) {
      return { what: `${item} starts at ${clockMs(at)}, before item ${k} (${clockMs(prev)})`, sub }
    }
    if (at < start - TIME_SLACK_S || (end !== undefined && at > end + TIME_SLACK_S)) {
      const seg = end !== undefined ? `outside the segment (${clockMs(start)}–${clockMs(end)})` : `before the segment starts (${clockMs(start)})`
      return { what: `${item} starts at ${clockMs(at)}, ${seg}`, sub }
    }
    prev = at
  }
  return undefined
}
