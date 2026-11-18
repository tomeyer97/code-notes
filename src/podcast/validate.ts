// The full check of a podcast file (docs/podcast-format.md, "Validation"): every problem, its level and where it is in
// the file. One function, used by the player (whether it can play the file, and what to say in the panel and the
// Journeys view), the "Code Notes" output, the Problems view (diagnostics on the `.podcast.json`), and, ported rule
// for rule, by the code-journey skill's `journey.py podcast` (the cases in test/fixtures/podcast/cases.json run
// through both). No vscode here.

import { clock, Episode, JourneyShape, LINK_CODES, Podcast, PodcastProblem, resolveEpisode, segmentName, segProblem, WrittenSegment } from './model'

/** What is known around the file: the journey next to it, its audio file (looked at or not), the audio's real length
 *  (once the panel has loaded it). */
export interface PodcastContext {
  journey?: JourneyShape & { id: string }
  /** undefined: not looked at. */
  audio?: { exists: boolean; size?: number }
  /** Seconds, as the panel's audio element reports it. */
  audioDuration?: number
}

export interface Validation {
  /** The file read, when its shape is right. */
  podcast?: Podcast
  /** The episode, when it can be played. */
  episode?: Episode
  problems: PodcastProblem[]
  /** No error: it can be played. */
  playable: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const error = (code: string, message: string, path: (string | number)[] = []): PodcastProblem => ({ level: 'error', code, message, path })
const warning = (code: string, message: string, path: (string | number)[] = []): PodcastProblem => ({ level: 'warning', code, message, path })

/** Times this close (s) are the same time (rounding in a generator). */
const SLACK_S = 0.05
/** The declared duration and the audio's own length may differ this much (s, or this share of it) before it is said. */
const DURATION_SLACK_S = 1
const DURATION_SLACK_SHARE = 0.01
const CUES = new Set(['map', 'open', 'beat'])

/**
 * `audio` as written, when it can't be used: a URL, an absolute path, or a path out of the folder the podcast is in
 * (the panel can only load files from the journeys folder: docs/podcast-format.md).
 */
export function audioPathProblem(audio: string): string | undefined {
  const a = audio.replace(/\\/g, '/')
  if (/^[a-z][a-z0-9+.-]*:/i.test(a) && !/^[a-z]:\//i.test(a)) return `audio must be a file in the journeys folder, not a URL (got ${audio})`
  if (a.startsWith('/') || /^[a-z]:\//i.test(a)) return `audio must be in the journeys folder, as a path relative to the podcast file (got ${audio})`
  let depth = 0
  for (const part of a.split('/')) {
    if (part === '..') depth--
    else if (part && part !== '.') depth++
    if (depth < 0) return `audio must be in the journeys folder (got ${audio})`
  }
  return undefined
}

/** The file's text checked, in full. Errors first, then the warnings in file order. */
export function validatePodcast(raw: string, ctx: PodcastContext = {}): Validation {
  const problems: PodcastProblem[] = []
  const fail = (p: PodcastProblem): Validation => ({ problems: [p, ...problems], playable: false })
  let d: unknown
  try { d = JSON.parse(raw) } catch (e) {
    if (!raw.trim()) return fail(error('json', 'the file is empty'))
    return fail(error('json', `not valid JSON: ${jsonSyntaxError(raw) ?? (e as Error).message}`))
  }
  if (!isObj(d)) return fail(error('object', 'not a podcast: the file is not a JSON object'))
  if (d.version !== 1) {
    return fail(error('version', d.version === undefined ? 'no "version" (this player reads version 1)' : `version ${JSON.stringify(d.version)}: this player reads version 1`, d.version === undefined ? [] : ['version']))
  }
  const errors: PodcastProblem[] = []
  // The audio.
  const audio = typeof d.audio === 'string' ? d.audio.trim() : ''
  if (!audio) errors.push(error('audio', d.audio === undefined ? 'no "audio": the audio file, relative to this file' : '"audio" is not a file name', d.audio === undefined ? [] : ['audio']))
  else {
    const where = audioPathProblem(audio)
    if (where) errors.push(error('audio-outside', where, ['audio']))
    else if (ctx.audio && !ctx.audio.exists) errors.push(error('audio-missing', `the audio file ${audio} isn't there`, ['audio']))
    else if (ctx.audio && ctx.audio.size === 0) errors.push(error('audio-empty', `the audio file ${audio} is empty`, ['audio']))
  }
  // The segments: missing, not a list, empty (F42).
  if (d.segments === undefined) errors.push(error('segments', 'no "segments": the parts of the episode'))
  else if (!Array.isArray(d.segments)) errors.push(error('segments', `"segments" is not a list (it is ${typeof d.segments === 'object' ? 'an object' : `a ${typeof d.segments}`})`, ['segments']))
  else if (!d.segments.length) errors.push(error('segments', '"segments" is empty: the episode has no parts', ['segments']))

  const j = isObj(d.journey) ? d.journey : {}
  const segs: unknown[] = Array.isArray(d.segments) ? d.segments : []
  const written: { s: WrittenSegment; i: number }[] = []
  segs.forEach((s, i) => {
    if (isObj(s)) written.push({ s: s as WrittenSegment, i })
    else problems.push(warning('segment', `segment #${i + 1} is not an object; skipped`, ['segments', i]))
  })
  const podcast: Podcast = {
    version: 1,
    title: typeof d.title === 'string' ? d.title : '',
    journey: { id: typeof j.id === 'string' ? j.id : '', file: typeof j.file === 'string' ? j.file : undefined, commit: typeof j.commit === 'string' ? j.commit : undefined },
    audio,
    duration: num(d.duration),
    // Each segment at its index in the file, so that problems point at it (the ones not objects are left out below).
    segments: written.map((x) => x.s),
  }
  // The journey it was written for (F40).
  if (podcast.journey.id && ctx.journey && podcast.journey.id !== ctx.journey.id) {
    problems.push(warning('journey', `written for journey "${podcast.journey.id}", but it is next to "${ctx.journey.id}": it plays with the journey next to it`, ['journey', 'id']))
  }
  if (d.duration !== undefined && !(num(d.duration)! > 0)) problems.push(warning('duration', `"duration" ${JSON.stringify(d.duration)} is not a length in seconds; ignored`, ['duration']))

  problems.push(...timingProblems(written, podcast.duration))
  // Where each segment is shown (an unknown step, a beat the step doesn't have: F30), when the journey is known.
  let episode: Episode | undefined
  if (ctx.journey) {
    episode = resolveEpisode(podcast, ctx.journey)
    // resolveEpisode's indexes are into podcast.segments: back to the file's.
    for (const p of episode.problems) {
      const k = p.path[1]
      if (typeof k === 'number') p.path = ['segments', written[k]?.i ?? k, ...p.path.slice(2)]
    }
    // Its start-time warnings are timingProblems' already.
    problems.push(...episode.problems.filter((p) => p.code !== 'start'))
    episode.problems = episode.problems.filter((p) => p.code !== 'start')
    episode.warnings = episode.problems.map((p) => p.message)
  }
  // The audio's real length, once known (F43, F37).
  if (ctx.audioDuration !== undefined && ctx.audioDuration > 0) problems.push(...audioLengthProblems(written, podcast.duration, ctx.audioDuration))

  if (written.length && !written.some((x) => num(x.s.start) !== undefined && num(x.s.start)! >= 0)) {
    errors.push(error('segments', 'no segment has a start time: nothing to play', ['segments']))
  }
  problems.sort((a, b) => order(a.path) - order(b.path))
  const all = [...errors, ...problems]
  const playable = !errors.length
  return { podcast, episode: playable ? episode : undefined, problems: all, playable }
}

/** File order of a problem: the segment's index (file-level ones first). */
const order = (path: (string | number)[]) => (path[0] === 'segments' && typeof path[1] === 'number' ? path[1] + 1 : 0)

/** Start, end and order of the segments (F35): each problem on its segment. */
function timingProblems(written: { s: WrittenSegment; i: number }[], duration: number | undefined): PodcastProblem[] {
  const out: PodcastProblem[] = []
  const ids = new Map<string, number>()
  let prevInFile: { name: string; start: number } | undefined
  const timed: { s: WrittenSegment; i: number; start: number; end?: number }[] = []
  for (const { s, i } of written) {
    const name = segmentName(s, i)
    if (typeof s.id === 'string' && s.id) {
      if (ids.has(s.id)) out.push(segProblem(s, i, 'id', `the id "${s.id}" is used by segment #${ids.get(s.id)! + 1} too`, ['id']))
      else ids.set(s.id, i)
    }
    if (s.cue !== undefined && !(typeof s.cue === 'string' && CUES.has(s.cue))) out.push(segProblem(s, i, 'cue', `cue ${JSON.stringify(s.cue)} is not map, open or beat; ignored`, ['cue']))
    const start = num(s.start)
    if (start === undefined || start < 0) {
      out.push(segProblem(s, i, 'start', `${s.start === undefined ? 'no start time' : `start ${JSON.stringify(s.start)} is not a time in seconds`}; skipped`, s.start === undefined ? [] : ['start']))
      continue
    }
    let end = num(s.end)
    if (s.end !== undefined && end === undefined) out.push(segProblem(s, i, 'end', `end ${JSON.stringify(s.end)} is not a time in seconds; it ends where the next one starts`, ['end']))
    if (end !== undefined && end < start - SLACK_S) {
      out.push(segProblem(s, i, 'end-before-start', `ends at ${clockMs(end)}, before it starts (${clockMs(start)})`, ['end']))
      end = undefined
    }
    if (prevInFile && start < prevInFile.start - SLACK_S) {
      out.push(segProblem(s, i, 'order', `starts at ${clockMs(start)}, before segment ${prevInFile.name} above it (${clockMs(prevInFile.start)}): segments play in time order, not in file order`, ['start']))
    }
    if (duration !== undefined && duration > 0 && (end ?? start) > duration + SLACK_S) {
      out.push(segProblem(s, i, 'past-duration', `${end !== undefined ? `ends at ${clockMs(end)}` : `starts at ${clockMs(start)}`}, after the episode's "duration" (${clockMs(duration)})`, [end !== undefined ? 'end' : 'start']))
    }
    prevInFile = { name, start }
    timed.push({ s, i, start, end })
  }
  // Overlaps, in time order: a segment starting before the one before it ends.
  const sorted = [...timed].sort((a, b) => a.start - b.start || a.i - b.i)
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1], b = sorted[k]
    if (a.end !== undefined && b.start < a.end - SLACK_S) {
      out.push(segProblem(b.s, b.i, 'overlap', `starts at ${clockMs(b.start)}, before segment ${segmentName(a.s, a.i)} ends (${clockMs(a.end)}): the later one wins from its start`, ['start']))
    }
  }
  return out
}

/** The segments and the declared duration against the audio's real length. */
function audioLengthProblems(written: { s: WrittenSegment; i: number }[], duration: number | undefined, audioLen: number): PodcastProblem[] {
  const out: PodcastProblem[] = []
  const ends = written.map(({ s }) => num(s.end) ?? num(s.start)).filter((x): x is number => x !== undefined)
  const episodeLen = Math.max(duration ?? 0, ...ends, 0)
  const slack = Math.max(DURATION_SLACK_S, audioLen * DURATION_SLACK_SHARE)
  const past = written.filter(({ s }) => (num(s.start) ?? -1) >= audioLen)
  if (episodeLen > audioLen + Math.max(2, slack) && past.length) {
    // Cut off: one plain sentence, not a warning per part.
    out.push(warning('audio-short', `The audio is ${clock(audioLen)} long but the episode is ${clock(episodeLen)}: the file looks cut off (${past.length} ${past.length === 1 ? 'part starts' : 'parts start'} after its end)`, ['audio']))
    return out
  }
  if (duration !== undefined && Math.abs(duration - audioLen) > slack) {
    out.push(warning('duration', `"duration" says ${clockMs(duration)} but the audio is ${clockMs(audioLen)} long`, ['duration']))
  }
  for (const { s, i } of written) {
    const end = num(s.end)
    if (end !== undefined && end > audioLen + slack) out.push(segProblem(s, i, 'past-audio', `ends at ${clockMs(end)}, after the audio's end (${clockMs(audioLen)})`, ['end']))
  }
  return out
}

/** m:ss.s: a time in a message, precise enough to find the segment. */
function clockMs(t: number): string {
  const tenths = Math.round(t * 10) / 10
  const whole = Math.floor(tenths)
  const frac = Math.round((tenths - whole) * 10)
  return frac ? `${clock(whole)}.${frac}` : clock(whole)
}

// ---------- what the panel and the Journeys view say ----------

/** How many segments can't be shown as written (an unknown step, a beat the step doesn't have, no "at"). */
export const brokenLinks = (problems: PodcastProblem[]) => new Set(problems.filter((p) => LINK_CODES.has(p.code)).map((p) => p.segment)).size

/**
 * One short line about what is wrong with a podcast that plays (undefined: nothing to say). `writtenFor`: the title of
 * the journey it was written for, when it is another one.
 */
export function playNotice(problems: PodcastProblem[], writtenFor?: string): string | undefined {
  const parts: string[] = []
  const short = problems.find((p) => p.code === 'audio-short')
  if (short) parts.push(short.message.replace(/ \(\d+ parts? starts? after its end\)$/, ''))
  if (problems.some((p) => p.code === 'journey')) parts.push(`Written for “${writtenFor ?? problems.find((p) => p.code === 'journey')!.message.match(/"([^"]*)"/)![1]}”`)
  const links = brokenLinks(problems)
  if (links) parts.push(`${links} ${links === 1 ? "part can't" : "parts can't"} be shown`)
  const rest = problems.filter((p) => p.level === 'warning' && p.code !== 'audio-short' && p.code !== 'journey' && !LINK_CODES.has(p.code)).length
  if (rest && parts.length < 2) parts.push(`${rest} ${rest === 1 ? 'problem' : 'problems'} in the podcast file`)
  return parts.length ? parts.slice(0, 2).join(' · ') : undefined
}

// ---------- where a problem is in the text ----------

/** A range of the text (offsets). */
export interface Span { start: number; end: number }

/**
 * Where the value at `path` is in the JSON text (the deepest part of the path that is there; the whole text when
 * none is). For invalid JSON, the place the parser stopped.
 */
export function locate(raw: string, path: (string | number)[]): Span {
  let spans: Map<string, Span>
  try { spans = valueSpans(raw) } catch (e) {
    const at = e instanceof JsonSyntax ? e.at : 0
    return { start: at, end: Math.min(raw.length, at + 1) }
  }
  for (let n = path.length; n >= 0; n--) {
    const s = spans.get(JSON.stringify(path.slice(0, n)))
    if (s) return s
  }
  return { start: 0, end: 0 }
}

/** Where invalid JSON stops being JSON, and what was there. */
export class JsonSyntax extends Error {
  constructor(readonly at: number, what: string) { super(what) }
}

/** Invalid JSON said for an author: "line 3, column 12: unexpected "}"" (the engine's own message names no place). */
export function jsonSyntaxError(raw: string): string | undefined {
  try { valueSpans(raw); return undefined } catch (e) {
    if (!(e instanceof JsonSyntax)) return String(e)
    const { line, col } = lineCol(raw, e.at)
    return `line ${line + 1}, column ${col + 1}: ${e.message}`
  }
}

/** Every value's span in the JSON text, by its path (JSON of the keys and indexes); a key's value spans from the key.
 *  Strict: anything that isn't JSON throws a JsonSyntax with its place. */
function valueSpans(raw: string): Map<string, Span> {
  const out = new Map<string, Span>()
  let i = 0
  const bad = (what?: string): never => {
    throw new JsonSyntax(i, what ?? (i >= raw.length ? 'the file ends too early (cut off?)' : `unexpected ${JSON.stringify(raw[i])}`))
  }
  const ws = () => { while (i < raw.length && ' \t\n\r'.includes(raw[i])) i++ }
  const expect = (c: string) => { ws(); if (raw[i] !== c) bad(i >= raw.length ? undefined : `expected ${JSON.stringify(c)}, found ${JSON.stringify(raw[i])}`); i++ }
  const str = (): string => {
    if (raw[i] !== '"') bad()
    const s = i
    i++
    while (i < raw.length && raw[i] !== '"') {
      if (raw[i] === '\n') bad('a line break inside a string')
      i += raw[i] === '\\' ? 2 : 1
    }
    if (i >= raw.length) bad()
    i++
    try { return JSON.parse(raw.slice(s, i)) as string } catch { i = s; return bad('a bad escape in a string') }
  }
  const value = (path: (string | number)[], from?: number): void => {
    ws()
    const start = from ?? i
    const c = raw[i]
    if (c === '{') {
      i++
      ws()
      if (raw[i] === '}') i++
      else for (;;) {
        ws()
        const keyAt = i
        const k = str()
        expect(':')
        value([...path, k], keyAt)
        ws()
        if (raw[i] === ',') { i++; continue }
        if (raw[i] === '}') { i++; break }
        bad(i >= raw.length ? undefined : `expected "," or "}", found ${JSON.stringify(raw[i])}`)
      }
    } else if (c === '[') {
      i++
      ws()
      let n = 0
      if (raw[i] === ']') i++
      else for (;;) {
        value([...path, n++])
        ws()
        if (raw[i] === ',') { i++; continue }
        if (raw[i] === ']') { i++; break }
        bad(i >= raw.length ? undefined : `expected "," or "]", found ${JSON.stringify(raw[i])}`)
      }
    } else if (c === '"') str()
    else {
      const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i, i + 64))
      if (!m) bad()
      i += m![0].length
    }
    out.set(JSON.stringify(path), { start, end: i })
  }
  value([])
  ws()
  if (i < raw.length) bad()
  return out
}

/** Line and column (0-based) of an offset. */
export function lineCol(raw: string, offset: number): { line: number; col: number } {
  let line = 0, last = -1
  for (let k = 0; k < offset && k < raw.length; k++) if (raw[k] === '\n') { line++; last = k }
  return { line, col: offset - last - 1 }
}
