// A journey's podcast (docs/podcast-format.md): one audio file whose parts are linked to the journey's steps and
// animation beats. This reads the file, checks it against the journey, and answers the one question the player asks
// all the time: at this second of the audio, where should the journey be? No vscode here: unit tests use it as is
// (test/podcastModel.test.ts), and the player (player.ts) applies what it says. The full check of a file, with every
// problem and where it is, is validate.ts.

import { CodeMark, codeMarkOf, markShapeProblem } from '../marks/model'

/** Where a segment belongs in the journey, as written: null (the whole journey: the map), or a step by id, with the
 *  1-based position of a beat in that step's `scene.beats`. */
export type WrittenAt = null | { step: string; beat?: number }

/** Something wrong with a podcast file (validate.ts). `error`: it can't be played; `warning`: it plays, but a part of
 *  it is not what the file says. `path`: where in the file (JSON keys and indexes); `segment`: the segment's id. */
export interface PodcastProblem {
  /** `info`: worth knowing, nothing wrong with the file (recorded for an older commit: validate.ts). */
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  path: (string | number)[]
  segment?: string
  /** A problem said once for several segments (a step the journey doesn't have): every one of them. */
  segments?: string[]
}

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

/** The podcast file, checked for its shape only (parsePodcast). */
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

/** A podcast resolved against its journey: every segment's view, in time order, and what did not match. */
export interface Episode {
  title: string
  duration: number
  segments: Segment[]
  chapters: Chapter[]
  /** What could not be followed (an unknown step, a beat the step does not have, …): the messages of `problems`. */
  warnings: string[]
  /** The same, with the segment and where it is in the file. */
  problems: PodcastProblem[]
}

/** What the player needs of the journey: its steps' ids and how many beats each one's animation has. */
export interface JourneyShape { steps: { id: string; beats: number; file?: string; beatFiles?: (string | null)[] }[] }

/** The podcast file next to a journey file: `x.json` → `x.podcast.json`. */
export const podcastFileOf = (journeyPath: string) => journeyPath.replace(/\.json$/i, '') + '.podcast.json'
/** A podcast file is never read as a journey. */
export const isPodcastFile = (name: string) => /\.podcast\.json$/i.test(name)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The file's text as a Podcast, or why it can't be one. Only the shape is checked; each segment is checked later. */
export function parsePodcast(raw: string): Podcast | string {
  let d: unknown
  try { d = JSON.parse(raw) } catch (e) { return `not JSON: ${(e as Error).message}` }
  if (!isObj(d)) return 'not an object'
  if (d.version !== 1) return `version ${JSON.stringify(d.version)} (this player reads version 1)`
  if (typeof d.audio !== 'string' || !d.audio.trim()) return 'no "audio" file'
  if (d.segments === undefined) return 'no "segments"'
  if (!Array.isArray(d.segments)) return '"segments" is not a list'
  if (!d.segments.length) return '"segments" is empty'
  const j = isObj(d.journey) ? d.journey : {}
  return {
    version: 1,
    title: typeof d.title === 'string' ? d.title : '',
    journey: { id: typeof j.id === 'string' ? j.id : '', file: typeof j.file === 'string' ? j.file : undefined, commit: typeof j.commit === 'string' ? j.commit : undefined },
    audio: d.audio,
    duration: num(d.duration),
    segments: d.segments.filter(isObj) as WrittenSegment[],
  }
}

/**
 * The podcast against its journey. Each segment's `at` becomes a view; one the journey can't show degrades instead
 * of breaking the episode: a beat the step doesn't have (beats are linked by position) shows the step only; an
 * unknown step, or an `at` that isn't one, keeps the view of the segment before it. `cue: "map"` on a step shows the
 * step without its animation. Segments without a usable start are dropped; a missing end is the next one's start.
 */
export function resolveEpisode(p: Podcast, journey: JourneyShape): Episode {
  const problems: PodcastProblem[] = []
  const byId = new Map(journey.steps.map((s, i) => [s.id, { n: i + 1, beats: s.beats }]))
  const timed = p.segments
    .map((s, i) => ({ s, i, start: num(s.start) }))
    .filter((x) => {
      const ok = x.start !== undefined && x.start >= 0
      if (!ok) problems.push(segProblem(x.s, x.i, 'start', `${x.s.start === undefined ? 'no start time' : `start ${JSON.stringify(x.s.start)} is not a time in seconds`}; skipped`, ['start']))
      return ok
    })
    .sort((a, b) => a.start! - b.start! || a.i - b.i)
  let prev: View = { step: 0 }
  const segments: Segment[] = timed.map((x, k) => {
    const id = typeof x.s.id === 'string' ? x.s.id : `#${x.i + 1}`
    const view = viewOf(x.s, x.i, byId, prev, problems)
    prev = view
    const next = timed[k + 1]?.start
    const end = num(x.s.end) ?? next ?? num(p.duration) ?? x.start!
    const stepId = view.step ? journey.steps[view.step - 1]?.id : undefined
    const seg: Segment = { id, start: x.start!, end: Math.max(end, x.start!), text: typeof x.s.text === 'string' ? x.s.text : '', speaker: typeof x.s.speaker === 'string' ? x.s.speaker : '', ...view, ...(stepId ? { stepId } : {}) }
    // Sentence times are all or nothing: one bad item and the player estimates them all (validate.ts says why).
    const known = sentenceBound(x.s, x.start!, next, p.duration)
    if (x.s.sentences !== undefined && !sentencesProblem(x.s.sentences, x.start!, known)) {
      seg.sentences = (x.s.sentences as Sentence[]).map((t) => ({ start: t.start, text: t.text }))
    }
    const marks = marksOf(x.s.marks, seg.text, seg.start, seg.end, x.s.at === null)
    if (marks) seg.marks = marks
    return seg
  })
  const last = segments[segments.length - 1]
  const duration = Math.max(num(p.duration) ?? 0, last ? last.end : 0)
  return { title: p.title, duration, segments, chapters: chaptersOf(segments, duration), warnings: problems.map((w) => w.message), problems }
}

/** The name a segment goes by in messages: its id, else its place in the file (1-based). */
export const segmentName = (s: WrittenSegment, i: number) => (typeof s.id === 'string' && s.id ? s.id : `#${i + 1}`)

/** A warning about segment `i` (index in the file) at `sub` (keys within it). */
export function segProblem(s: WrittenSegment, i: number, code: string, what: string, sub: (string | number)[] = []): PodcastProblem {
  const name = segmentName(s, i)
  return { level: 'warning', code, message: `segment ${name}: ${what}`, path: ['segments', i, ...sub], segment: name }
}

/** Sentence times this close (s) to the segment's bounds or to each other count as in order (rounding in a generator). */
const SENTENCE_SLACK_S = 0.05

/** The latest a segment's sentence may start: its end as written, else the next segment's start, else the episode's
 *  duration; undefined when none is known (the last segment of a file without "duration": no limit). */
export function sentenceBound(s: WrittenSegment, start: number, next: number | undefined, duration: number | undefined): number | undefined {
  const end = num(s.end) ?? next ?? num(duration)
  return end === undefined ? undefined : Math.max(end, start)
}

/**
 * What is wrong with a segment's `sentences` (undefined: they can be used): not a non-empty list of { start, text },
 * starts not in order, or a start outside the segment (`start` to `end`; no end: from `start` on). `what`: the
 * problem in words; `sub`: where it is within the segment.
 */
export function sentencesProblem(v: unknown, start: number, end: number | undefined): { what: string; sub: (string | number)[] } | undefined {
  if (!Array.isArray(v) || !v.length) return { what: Array.isArray(v) ? 'sentences is empty' : 'sentences is not a list of { start, text }', sub: ['sentences'] }
  let prev: number | undefined
  for (let k = 0; k < v.length; k++) {
    const t = v[k]
    if (!isObj(t) || typeof t.text !== 'string' || !t.text.trim()) return { what: `sentences: item ${k + 1} is not { start, text } with a text`, sub: ['sentences', k] }
    const at = num(t.start)
    if (at === undefined) return { what: `sentences: item ${k + 1} has no start time in seconds`, sub: ['sentences', k, 'start'] }
    if (prev !== undefined && at < prev - SENTENCE_SLACK_S) return { what: `sentences: item ${k + 1} starts at ${clockMs(at)}, before item ${k} (${clockMs(prev)})`, sub: ['sentences', k, 'start'] }
    if (at < start - SENTENCE_SLACK_S || (end !== undefined && at > end + SENTENCE_SLACK_S)) {
      const seg = end !== undefined ? `outside the segment (${clockMs(start)}–${clockMs(end)})` : `before the segment starts (${clockMs(start)})`
      return { what: `sentences: item ${k + 1} starts at ${clockMs(at)}, ${seg}`, sub: ['sentences', k, 'start'] }
    }
    prev = at
  }
  return undefined
}

/** Codes of the problems that are a link the journey can't show (a part that can't be shown as written). */
export const LINK_CODES = new Set(['at', 'step', 'beat'])

/** One segment's view (see resolveEpisode); `i`: its index in the file; `prev`: the view before it. */
function viewOf(s: WrittenSegment, i: number, byId: Map<string, { n: number; beats: number }>, prev: View, problems: PodcastProblem[]): View {
  const at = s.at
  if (at === null) return { step: 0 }
  if (!isObj(at) || typeof at.step !== 'string') {
    problems.push(segProblem(s, i, 'at', `"at" is ${at === undefined ? 'missing' : 'not null or { step, beat }'}; it keeps the view before it`, at === undefined ? [] : ['at']))
    return prev
  }
  const st = byId.get(at.step)
  if (!st) {
    problems.push(segProblem(s, i, 'step', `no step "${at.step}" in the journey; it keeps the view before it`, ['at', 'step']))
    return prev
  }
  if (at.beat === undefined || s.cue === 'map') return { step: st.n }
  const b = at.beat
  // A beat written as a string ("2") is not beat 2: said as what it is, not as a beat the step lacks (F104).
  if (typeof b === 'string') {
    problems.push(segProblem(s, i, 'beat', `beat must be a number, got the string ${JSON.stringify(b)}; the step only`, ['at', 'beat']))
    return { step: st.n }
  }
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > st.beats) {
    problems.push(segProblem(s, i, 'beat', `step "${at.step}" has no beat ${JSON.stringify(b)} (it has ${st.beats}); the step only`, ['at', 'beat']))
    return { step: st.n }
  }
  return { step: st.n, beat: b - 1 }
}

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

/** Where the journey should be at second `t` (any `t`: before the start, past the end), and the segment saying it. */
export function viewAt(ep: Episode, t: number): View & { seg: number } {
  const i = segmentAt(ep.segments, t)
  if (i < 0) return { seg: -1, step: 0 }
  const s = ep.segments[i]
  return s.beat === undefined ? { seg: i, step: s.step } : { seg: i, step: s.step, beat: s.beat }
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
 * card's ‹ Previous goes to the step before: one meaning for "previous" (F73); the first part's ⏮ is its start.
 */
export function chapterJump(ep: Episode, t: number, dir: 1 | -1): number {
  const cs = ep.chapters
  if (!cs.length) return dir > 0 ? ep.duration : 0
  const i = Math.max(0, cs.findIndex((c, k) => t >= c.start && (t < c.end || k === cs.length - 1)))
  if (dir > 0) return i + 1 < cs.length ? cs[i + 1].start : ep.duration
  return i === 0 ? cs[0].start : cs[i - 1].start
}

/** While playing, a view is held at least this long (s): a shorter part that would open another file doesn't (F79). */
export const VIEW_HOLD_S = 8

/**
 * The view each segment shows while the episode plays (by index): its own, except in a run of segments on one file
 * that lasts less than `hold` seconds (gaps included) and would switch the file shown: that run keeps the view before it
 * (it is coalesced into its neighbour), so the editor doesn't swap files for a three-second mention. Beats in the same
 * file move as written. The first run always shows. A seek shows the exact view at its time (viewAt), not this.
 * `fileOf`: the file a view shows ('' for the map).
 */
export function calmViews(ep: Episode, fileOf: (v: View) => string, hold = VIEW_HOLD_S): View[] {
  const segs = ep.segments
  const own = (s: Segment): View => (s.beat === undefined ? { step: s.step } : { step: s.step, beat: s.beat })
  const out: View[] = []
  for (let k = 0; k < segs.length;) {
    const f = fileOf(own(segs[k]))
    let e = k
    while (e + 1 < segs.length && fileOf(own(segs[e + 1])) === f) e++
    const until = e + 1 < segs.length ? segs[e + 1].start : Math.max(segs[e].end, ep.duration)
    // Short, and another file than the one on screen: held (the same file just moves the highlight).
    const held = k > 0 && fileOf(out[k - 1]) !== f && until - segs[k].start < hold
    for (let x = k; x <= e; x++) out.push(held ? out[k - 1] : own(segs[x]))
    k = e + 1
  }
  return out
}

/**
 * Runs `job` on the newest value only: one job at a time; values pushed while one runs replace each other, and only
 * the last of them runs next (a drag across the timeline, keys held down: the journey moves once, to where it ended).
 * `current(v)` tells a running job whether it is still the newest one (a superseded job stops early).
 */
export class LatestWins<T> {
  private running = false
  private pending: { v: T } | undefined
  private gen = 0
  constructor(private job: (v: T, current: () => boolean) => Promise<void>) {}

  push(v: T): void {
    this.gen++
    if (this.running) { this.pending = { v }; return }
    void this.run(v)
  }

  get busy(): boolean { return this.running }

  /** Settles once nothing runs or waits (tests). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 5))
  }

  private async run(v: T): Promise<void> {
    this.running = true
    let next: { v: T } | undefined = { v }
    while (next) {
      const mine = this.gen
      const now = next.v
      next = undefined
      try { await this.job(now, () => mine === this.gen) } catch { /* the job logs its own errors */ }
      next = this.pending
      this.pending = undefined
    }
    this.running = false
  }
}

// ---------- marks: word-timed highlights within a segment (docs/podcast-format.md, "Marks") ----------

/** A highlight that lights while the voice says `phrase`: a code mark (marks/model.ts) whose `file` defaults to the
 *  segment's beat's file, else its step's. */
export interface Mark extends CodeMark {
  phrase: string
  /** Seconds from the segment's start: when the phrase's first character is said. */
  at: number
}

/** A mark lights this long before its `at` (s): the eye gets there as the word is said, not after it. */
export const MARK_LEAD_S = 0.12
/** Marks' `at` this close (s) to the segment's bounds or to each other count as in order (rounding in a generator). */
const MARK_SLACK_S = 0.05

/**
 * What is wrong with a segment's `marks` (validate.ts says it; resolveEpisode leaves out the marks it names: `drop`).
 * `start`, `end`: the segment's times as the player has them; `onMap`: the segment's `at` is null (a mark then needs
 * its own `file`).
 */
export function marksProblems(v: unknown, text: string, start: number, end: number, onMap: boolean): { k?: number; what: string; sub: (string | number)[]; drop: boolean }[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) return [{ what: 'marks is not a list of { phrase, at, lines }; ignored', sub: ['marks'], drop: true }]
  const out: { k?: number; what: string; sub: (string | number)[]; drop: boolean }[] = []
  const len = Math.max(0, end - start)
  let prevAt: number | undefined
  let from = 0
  let prevPhrase: string | undefined
  let prevPos = -1
  v.forEach((m, k) => {
    const bad = (what: string, sub: (string | number)[] = []) => out.push({ k, what: `mark ${k + 1}: ${what}; ignored`, sub: ['marks', k, ...sub], drop: true })
    if (!isObj(m)) return bad('not an object { phrase, at, lines }')
    if (typeof m.phrase !== 'string' || !m.phrase.trim()) return bad('no phrase', m.phrase === undefined ? [] : ['phrase'])
    const at = num(m.at)
    if (at === undefined) return bad(m.at === undefined ? 'no "at" (seconds from the segment\'s start)' : `at ${JSON.stringify(m.at)} is not a time in seconds`, m.at === undefined ? [] : ['at'])
    if (at < -MARK_SLACK_S || at > len + MARK_SLACK_S) return bad(`at ${clockMs(start + at)} (${round2(at)} s) is outside the segment (${clockMs(start)}–${clockMs(end)})`, ['at'])
    const shape = markShapeProblem(m)
    if (shape) return bad(shape.what, shape.sub)
    if (m.file === undefined && onMap) return bad('a mark in a segment on the map ("at": null) needs its own "file"')
    // Kept, but worth saying: out of order (they light in time order), a phrase that isn't in the text.
    if (prevAt !== undefined && at < prevAt - MARK_SLACK_S) out.push({ k, what: `mark ${k + 1} lights at ${round2(at)} s, before mark ${k} (${round2(prevAt)} s): marks light in the order they are said`, sub: ['marks', k, 'at'], drop: false })
    // The same phrase as the mark before: the same words (two places at once).
    const p = m.phrase === prevPhrase ? prevPos : text.indexOf(m.phrase, from)
    if (p < 0) out.push({ k, what: `mark ${k + 1}: the phrase ${JSON.stringify(m.phrase)} isn't in the text${from ? ' after the phrase before it' : ''}`, sub: ['marks', k, 'phrase'], drop: false })
    else from = p + m.phrase.length
    prevPhrase = m.phrase
    prevPos = p
    prevAt = at
  })
  return out
}

const round2 = (t: number) => Math.round(t * 100) / 100

/** A segment's usable marks (marksProblems' dropped ones left out), in the order they light. */
export function marksOf(v: unknown, text: string, start: number, end: number, onMap: boolean): Mark[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined
  const drop = new Set(marksProblems(v, text, start, end, onMap).filter((p) => p.drop).map((p) => p.k))
  const out: Mark[] = []
  v.forEach((m, k) => {
    if (drop.has(k)) return
    const x = m as Record<string, unknown>
    out.push({ phrase: x.phrase as string, at: x.at as number, ...codeMarkOf(x) })
  })
  // Stable: marks said at the same time keep their order.
  out.sort((a, b) => a.at - b.at)
  return out.length ? out : undefined
}

/** When each of a segment's marks lights (s, in the episode): MARK_LEAD_S before `start + at`, never before the
 *  segment starts; a mark with the same phrase as the one before it lights with it (two places at once). */
export function markTimes(seg: { start: number; marks?: Mark[] }): number[] {
  const out: number[] = []
  const ms = seg.marks ?? []
  ms.forEach((m, k) => {
    out.push(k > 0 && ms[k - 1].phrase === m.phrase ? out[k - 1] : Math.max(seg.start, seg.start + m.at - MARK_LEAD_S))
  })
  return out
}

/** Of marks lighting at `times` (in order), how many are lit at second `t`, and from which one on they are the newest
 *  (the focus: the last lit, with any lit at the same time). */
export function marksAt(times: number[], t: number): { lit: number; focusFrom: number } {
  let lit = 0
  while (lit < times.length && times[lit] <= t + 1e-6) lit++
  let focusFrom = lit ? lit - 1 : 0
  while (focusFrom > 0 && times[focusFrom - 1] === times[lit - 1]) focusFrom--
  return { lit, focusFrom }
}

/**
 * Which of a segment's marks light (the view hold, F79, for marks): a mark in the file on screen lights; one in
 * another file opens it, but only once the file on screen has been there `hold` seconds; sooner it is skipped.
 * `own`: the segment's own file (a mark's default); `shown`: the file on screen as the segment starts, there since
 * `since` (s).
 */
export function planMarks(marks: Mark[], times: number[], own: string, shown: string, since: number, hold = VIEW_HOLD_S): { file: string; skip: boolean; opens: boolean }[] {
  let cur = shown, from = since
  return marks.map((m, k) => {
    const file = m.file ?? own
    if (file === cur) return { file, skip: false, opens: false }
    if (times[k] - from >= hold) {
      cur = file
      from = times[k]
      return { file, skip: false, opens: true }
    }
    return { file, skip: true, opens: false }
  })
}

/** m:ss.s: a time in a message, precise enough to find the segment. */
export function clockMs(t: number): string {
  const tenths = Math.round(t * 10) / 10
  const whole = Math.floor(tenths)
  const frac = Math.round((tenths - whole) * 10)
  return frac ? `${clock(whole)}.${frac}` : clock(whole)
}

/** m:ss (h:mm:ss past an hour). */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}
