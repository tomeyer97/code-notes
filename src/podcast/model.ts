// A journey's podcast (docs/podcast-format.md): one audio file whose parts are linked to the journey's steps and
// animation beats. This reads the file, checks it against the journey, and answers the one question the player asks
// all the time: at this second of the audio, where should the journey be? No vscode here: unit tests use it as is
// (test/podcast.test.ts), and the player (player.ts) applies what it says.

/** Where a segment belongs in the journey, as written: null (the whole journey: the map), or a step by id, with the
 *  1-based position of a beat in that step's `scene.beats`. */
export type WrittenAt = null | { step: string; beat?: number }

/** A segment as written in the file. */
export interface WrittenSegment {
  id?: string
  at?: unknown
  cue?: unknown
  speaker?: unknown
  text?: unknown
  start?: unknown
  end?: unknown
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
  start: number
  end: number
  text: string
  speaker: string
}

/** A run of segments on the same step (or on the map): what the timeline marks. */
export interface Chapter { start: number; end: number; step: number }

/** A podcast resolved against its journey: every segment's view, in time order, and what did not match. */
export interface Episode {
  title: string
  duration: number
  segments: Segment[]
  chapters: Chapter[]
  /** What could not be followed (an unknown step, a beat the step does not have, …): said in the log. */
  warnings: string[]
}

/** What the player needs of the journey: its steps' ids and how many beats each one's animation has. */
export interface JourneyShape { steps: { id: string; beats: number }[] }

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
  if (!Array.isArray(d.segments) || !d.segments.length) return 'no "segments"'
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
  const warnings: string[] = []
  const byId = new Map(journey.steps.map((s, i) => [s.id, { n: i + 1, beats: s.beats }]))
  const timed = p.segments
    .map((s, i) => ({ s, i, start: num(s.start) }))
    .filter((x) => {
      const ok = x.start !== undefined && x.start >= 0
      if (!ok) warnings.push(`segment ${x.s.id ?? x.i + 1}: no start time; skipped`)
      return ok
    })
    .sort((a, b) => a.start! - b.start! || a.i - b.i)
  let prev: View = { step: 0 }
  const segments: Segment[] = timed.map((x, k) => {
    const id = typeof x.s.id === 'string' ? x.s.id : `#${x.i + 1}`
    const view = viewOf(x.s, id, byId, prev, warnings)
    prev = view
    const next = timed[k + 1]?.start
    const end = num(x.s.end) ?? next ?? num(p.duration) ?? x.start!
    return { id, start: x.start!, end: Math.max(end, x.start!), text: typeof x.s.text === 'string' ? x.s.text : '', speaker: typeof x.s.speaker === 'string' ? x.s.speaker : '', ...view }
  })
  const last = segments[segments.length - 1]
  const duration = Math.max(num(p.duration) ?? 0, last ? last.end : 0)
  return { title: p.title, duration, segments, chapters: chaptersOf(segments, duration), warnings }
}

/** One segment's view (see resolveEpisode); `prev`: the view before it. */
function viewOf(s: WrittenSegment, id: string, byId: Map<string, { n: number; beats: number }>, prev: View, warnings: string[]): View {
  const at = s.at
  if (at === null) return { step: 0 }
  if (!isObj(at) || typeof at.step !== 'string') {
    warnings.push(`segment ${id}: "at" is ${at === undefined ? 'missing' : 'not null or { step, beat }'}; it keeps the view before it`)
    return prev
  }
  const st = byId.get(at.step)
  if (!st) {
    warnings.push(`segment ${id}: no step "${at.step}" in the journey; it keeps the view before it`)
    return prev
  }
  if (at.beat === undefined || s.cue === 'map') return { step: st.n }
  const b = at.beat
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > st.beats) {
    warnings.push(`segment ${id}: step "${at.step}" has no beat ${JSON.stringify(b)} (it has ${st.beats}); the step only`)
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

/** Within this many seconds of a chapter's start, "previous" goes to the chapter before (as a music player's ⏮). */
export const RESTART_GRACE_S = 3

/** The start of the chapter before (dir -1: this chapter's start, unless just past it) or after (dir 1) second `t`. */
export function chapterJump(ep: Episode, t: number, dir: 1 | -1): number {
  const cs = ep.chapters
  if (!cs.length) return dir > 0 ? ep.duration : 0
  const i = Math.max(0, cs.findIndex((c, k) => t >= c.start && (t < c.end || k === cs.length - 1)))
  if (dir > 0) return i + 1 < cs.length ? cs[i + 1].start : ep.duration
  return t - cs[i].start > RESTART_GRACE_S || i === 0 ? cs[i].start : cs[i - 1].start
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

/** m:ss (h:mm:ss past an hour). */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}
