// The full check of a podcast file (docs/podcast-format.md, "Validation"): every problem, its level and where it is in
// the file. The one reader of the file: the player (whether it can play it, and what to say in the panel and the
// Journeys view), the "Code Notes" output, the Problems view (diagnostics on the `.podcast.json`), and the
// code-journey skill's `journey.py podcast`, which runs it through journey-check.mjs (its own copy of the rules is
// only the fallback for machines without node; test/cli/podcast.test.mjs keeps the two in step). No vscode here.
//
// readPodcastText reads the file's shape once; validateRead runs the rules (RULES, in the order they are said) on it.

import { codeMarkOf, markCodeProblem } from '../marks'
import { VERSIONS } from '../versions'
import { clock, clockMs } from '../../clock'
import { jsonSyntaxError } from '../../json/spans'
import {
  Episode, IndexedSegment, LINK_CODES, Podcast, PodcastProblem, ProblemCode, segmentEnd, segmentName, segProblem,
  sentenceBound, sentencesProblem, startOf, WrittenSegment,
} from './format'
import { isObj, num, Path, TIME_SLACK_S } from './guards'
import { hasBadBeat, IdentifiedJourneyShape, JourneyShape, segmentFile, stepIndex } from './journeyShape'
import { marksProblems } from './marks'
import { noStart, resolveEpisode, TimedSegment, timedSegments } from './resolve'

/** What is known around the file: the journey next to it, its audio file (looked at or not), the audio's real length
 *  (once the panel has loaded it). */
export interface PodcastContext {
  journey?: IdentifiedJourneyShape
  /** undefined: not looked at. */
  audio?: { exists: boolean; size?: number }
  /** Seconds, as the panel's audio element reports it. */
  audioDuration?: number
  /** The journey's steps whose code changed since the commit the podcast was recorded for (`journey.commit`), by
   *  number (load.ts asks git; undefined: not known). */
  changed?: number[]
  /** A repository file's text, for the marks (relative path): null when it isn't there, undefined when not read
   *  (the player then finds out at play time). */
  files?: (path: string) => string | null | undefined
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

/** A podcast file's text read for its shape: what the rules check, and what the shape alone says. */
export interface PodcastText {
  /** The podcast, when the file is a JSON object of this version. */
  podcast?: Podcast
  /** The journey it names, when the file is a JSON object (of any version). */
  journey?: Podcast['journey']
  /** Its segments that are objects, at their index in the file. */
  written: IndexedSegment[]
  /** `duration` as written (the podcast keeps it only when it is a number). */
  writtenDuration?: unknown
  /** Why it can't be played. Not JSON, not an object or another version: that one error, and no podcast. */
  errors: PodcastProblem[]
  /** Warnings the shape gives (a segment that isn't an object). */
  problems: PodcastProblem[]
}

const problem = (level: PodcastProblem['level']) => (code: ProblemCode, message: string, path: Path = []): PodcastProblem =>
  ({ level, code, message, path })
const error = problem('error')
const warning = problem('warning')
const info = problem('info')

/** The declared duration and the audio's own length may differ this much (s, or this share of it) before it is said. */
const DURATION_SLACK_S = 1
const DURATION_SLACK_SHARE = 0.01
/** An episode this much (s, at least) longer than its audio, with parts after the audio's end: the file is cut off. */
const CUT_OFF_S = 2
const CUES = new Set(['map', 'open', 'beat'])

/** What the rules say, word for word (the checks below stay one line each). */
const SAY = {
  noVersion: () => `no "version" (this player reads version ${VERSIONS.podcast})`,
  otherVersion: (v: unknown) => `version ${JSON.stringify(v)}: this player reads version ${VERSIONS.podcast}`,
  noAudio: (v: unknown) => (v === undefined ? 'no "audio": the audio file, relative to this file' : '"audio" is not a file name'),
  audioMissing: (audio: string) => `the audio file ${audio} isn't there`,
  audioEmpty: (audio: string) => `the audio file ${audio} is empty`,
  segmentsNotList: (v: unknown) => `"segments" is not a list (it is ${typeof v === 'object' ? 'an object' : `a ${typeof v}`})`,
  notASegment: (i: number) => `segment #${i + 1} is not an object; skipped`,
  otherJourney: (id: string, next: string) => `written for journey "${id}", but it is next to "${next}": it plays with the journey next to it`,
  badDuration: (v: unknown) => `"duration" ${JSON.stringify(v)} is not a length in seconds; ignored`,
  duplicateId: (id: string, first: string, again: string) => `the id "${id}" is used twice (${first} and ${again})`,
  badCue: (cue: unknown) => `cue ${JSON.stringify(cue)} is not map, open or beat; ignored`,
  badEnd: (end: unknown) => `end ${JSON.stringify(end)} is not a time in seconds; it ends where the next one starts`,
  endBeforeStart: (end: number, start: number) => `ends at ${clockMs(end)}, before it starts (${clockMs(start)})`,
  outOfOrder: (start: number, above: { name: string; start: number }) =>
    `starts at ${clockMs(start)}, before segment ${above.name} above it (${clockMs(above.start)}): segments play in time order, not in file order`,
  pastDuration: (start: number, end: number | undefined, duration: number) =>
    `${end !== undefined ? `ends at ${clockMs(end)}` : `starts at ${clockMs(start)}`}, after the episode's "duration" (${clockMs(duration)})`,
  overlap: (start: number, before: string, end: number) =>
    `starts at ${clockMs(start)}, before segment ${before} ends (${clockMs(end)}): the later one wins from its start`,
  sentences: (what: string) => `${what}; the caption is estimated from the text instead`,
  narrationOrder: (late: FirstMention, before: FirstMention, more: number) =>
    `narrates step ${late.k + 1} ("${late.step}") after step ${before.k + 1} ("${before.step}"): ` +
    `the journey's steps were reordered since it was recorded; re-record it, or put the steps back` +
    (more > 1 ? ` (${more} steps out of order)` : ''),
  missingStep: (step: string, names: string[], from: number, to: number) => {
    const which = names.length === 1 ? `segment ${names[0]}` : `segments ${names[0]}–${names[names.length - 1]}`
    const keep = names.length === 1 ? 'it keeps the view before it' : 'they keep the view before them'
    return `step "${step}" isn't in the journey (${which}, ${clockMs(from)}–${clockMs(to)}): ${keep}`
  },
  recordedFor: (steps: number[]) => `Code changed since recording: ${steps.length === 1 ? 'step' : 'steps'} ${steps.join(', ')}`,
  cutOff: (audioLen: number, episodeLen: number, past: number) =>
    `The audio is ${clock(audioLen)} long but the episode is ${clock(episodeLen)}: ` +
    `the file looks cut off (${past} ${past === 1 ? 'part starts' : 'parts start'} after its end)`,
  durationVsAudio: (duration: number, audioLen: number) => `"duration" says ${clockMs(duration)} but the audio is ${clockMs(audioLen)} long`,
  pastAudio: (end: number, audioLen: number) => `ends at ${clockMs(end)}, after the audio's end (${clockMs(audioLen)})`,
}

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
  return validateRead(readPodcastText(raw), ctx)
}

/** The podcast file's text read for its shape: the one parser of the file (validateRead checks the rest). */
export function readPodcastText(raw: string): PodcastText {
  const fatal = (p: PodcastProblem): PodcastText => ({ written: [], errors: [p], problems: [] })
  let d: unknown
  try { d = JSON.parse(raw) } catch (e) {
    if (!raw.trim()) return fatal(error('json', 'the file is empty'))
    return fatal(error('json', `not valid JSON: ${jsonSyntaxError(raw) ?? (e as Error).message}`))
  }
  if (!isObj(d)) return fatal(error('object', 'not a podcast: the file is not a JSON object'))
  const journey = journeyOf(d.journey)
  if (d.version !== VERSIONS.podcast) {
    const p = d.version === undefined ? error('version', SAY.noVersion()) : error('version', SAY.otherVersion(d.version), ['version'])
    return { ...fatal(p), journey }
  }
  const audio = typeof d.audio === 'string' ? d.audio.trim() : ''
  const segs: unknown[] = Array.isArray(d.segments) ? d.segments : []
  const written: IndexedSegment[] = []
  const problems: PodcastProblem[] = []
  for (const [i, s] of segs.entries()) {
    if (isObj(s)) written.push({ s: s as WrittenSegment, i })
    else problems.push(warning('segment', SAY.notASegment(i), ['segments', i]))
  }
  const errors = [...audioNameErrors(d.audio, audio), ...segmentsErrors(d.segments)]
  if (written.length && !written.some((x) => startOf(x.s) !== undefined)) {
    errors.push(error('segments', 'no segment has a start time: nothing to play', ['segments']))
  }
  const podcast: Podcast = {
    version: VERSIONS.podcast,
    title: typeof d.title === 'string' ? d.title : '',
    journey,
    audio,
    duration: num(d.duration),
    // The segments that are objects; `written` keeps their index in the file, so that problems point at it.
    segments: written.map((x) => x.s),
  }
  return { podcast, journey, written, writtenDuration: d.duration, errors, problems }
}

/** The journey a podcast names (`journey`: { id, file, commit }), its fields that are strings. */
function journeyOf(v: unknown): Podcast['journey'] {
  const j = isObj(v) ? v : {}
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
  return { id: str(j.id) ?? '', file: str(j.file), commit: str(j.commit) }
}

/** `audio` missing or not a name (the audio file itself is checked against the context: audioFileErrors). */
function audioNameErrors(v: unknown, audio: string): PodcastProblem[] {
  if (audio) return []
  return [error('audio', SAY.noAudio(v), v === undefined ? [] : ['audio'])]
}

/** `segments` missing, not a list, or empty. */
function segmentsErrors(v: unknown): PodcastProblem[] {
  if (v === undefined) return [error('segments', 'no "segments": the parts of the episode')]
  if (!Array.isArray(v)) return [error('segments', SAY.segmentsNotList(v), ['segments'])]
  if (!v.length) return [error('segments', '"segments" is empty: the episode has no parts', ['segments'])]
  return []
}

/** The audio file named, against what the context knows of it: outside the journeys folder, not there, empty. */
function audioFileErrors(audio: string, ctx: PodcastContext): PodcastProblem[] {
  if (!audio) return []
  const where = audioPathProblem(audio)
  if (where) return [error('audio-outside', where, ['audio'])]
  if (ctx.audio && !ctx.audio.exists) return [error('audio-missing', SAY.audioMissing(audio), ['audio'])]
  if (ctx.audio && ctx.audio.size === 0) return [error('audio-empty', SAY.audioEmpty(audio), ['audio'])]
  return []
}

/** What every rule is given: the file read, its timed segments, the context, the episode (when the journey is known). */
interface Checked {
  read: PodcastText
  podcast: Podcast
  written: IndexedSegment[]
  /** The segments with a usable start, in time order (timedSegments). */
  timed: TimedSegment[]
  ctx: PodcastContext
  episode?: Episode
}

type Rule = (c: Checked) => PodcastProblem[]

/** The rules, in the order their problems are said (then sorted by segment, stably). */
const RULES: Rule[] = [
  otherJourney,
  badDuration,
  segmentFieldProblems,
  overlapProblems,
  sentenceProblems,
  markShapeProblems,
  narrationOrder,
  markCodeProblems,
  linkProblems,
  recordedFor,
  audioLengthProblems,
]

/** A file read by readPodcastText, checked in full against `ctx`. */
export function validateRead(read: PodcastText, ctx: PodcastContext = {}): Validation {
  const { podcast, written } = read
  if (!podcast) return { problems: [...read.errors], playable: false }
  // The audio file's errors and its name's never come together (no name: nothing to look at).
  const errors = [...audioFileErrors(podcast.audio, ctx), ...read.errors]
  const episode = ctx.journey ? episodeOf(podcast, written, ctx.journey) : undefined
  const checked: Checked = { read, podcast, written, timed: timedSegments(written), ctx, episode }
  const problems = [...read.problems, ...RULES.flatMap((rule) => rule(checked))]
  problems.sort((a, b) => order(a.path) - order(b.path))
  const playable = !errors.length
  return { podcast, episode: playable ? episode : undefined, problems: [...errors, ...problems], playable }
}

/** File order of a problem: the segment's index (file-level ones first). */
const order = (path: Path) => (path[0] === 'segments' && typeof path[1] === 'number' ? path[1] + 1 : 0)

/** The episode against the journey, its problems pointing into the file: start times are segmentFieldProblems', a
 *  step the journey doesn't have is said once. */
function episodeOf(podcast: Podcast, written: IndexedSegment[], journey: JourneyShape): Episode {
  const ep = resolveEpisode(podcast, journey)
  // resolveEpisode's indexes are into podcast.segments: back to the file's.
  const inFile = ep.problems.map((p) => {
    const k = p.path[1]
    return typeof k === 'number' ? { ...p, path: ['segments', written[k]?.i ?? k, ...p.path.slice(2)] } : p
  })
  return { ...ep, problems: missingStepsOnce(inFile.filter((p) => p.code !== 'start'), written) }
}

// ---------- the rules ----------

/** Written for another journey than the one next to it. */
function otherJourney({ podcast, ctx }: Checked): PodcastProblem[] {
  const id = podcast.journey.id
  if (!id || !ctx.journey || id === ctx.journey.id) return []
  return [warning('journey', SAY.otherJourney(id, ctx.journey.id), ['journey', 'id'])]
}

/** A `duration` that isn't a length in seconds. */
function badDuration({ read }: Checked): PodcastProblem[] {
  const d = read.writtenDuration
  return d !== undefined && !((num(d) ?? 0) > 0) ? [warning('duration', SAY.badDuration(d), ['duration'])] : []
}

/** A segment's end as written when it can be used: a time, not before its start. */
function usableEnd(s: WrittenSegment, start: number): number | undefined {
  const end = num(s.end)
  return end !== undefined && end >= start - TIME_SLACK_S ? end : undefined
}

/** Each segment's own fields, in file order: its id, cue, start and end, and its start against the one above it. */
function segmentFieldProblems({ written, podcast }: Checked): PodcastProblem[] {
  const out: PodcastProblem[] = []
  const firstWithId = new Map<string, { i: number; start: unknown }>()
  let above: { name: string; start: number } | undefined
  const duration = podcast.duration
  for (const { s, i } of written) {
    if (typeof s.id === 'string' && s.id) {
      const first = firstWithId.get(s.id)
      if (first) out.push(segProblem(s, i, 'id', SAY.duplicateId(s.id, placeOf(first), placeOf({ i, start: s.start })), ['id']))
      else firstWithId.set(s.id, { i, start: s.start })
    }
    if (s.cue !== undefined && !(typeof s.cue === 'string' && CUES.has(s.cue))) out.push(segProblem(s, i, 'cue', SAY.badCue(s.cue), ['cue']))
    const start = startOf(s)
    if (start === undefined) {
      out.push(segProblem(s, i, 'start', noStart(s), s.start === undefined ? [] : ['start']))
      continue
    }
    const end = usableEnd(s, start)
    if (s.end !== undefined && num(s.end) === undefined) out.push(segProblem(s, i, 'end', SAY.badEnd(s.end), ['end']))
    if (num(s.end) !== undefined && end === undefined) out.push(segProblem(s, i, 'end-before-start', SAY.endBeforeStart(num(s.end)!, start), ['end']))
    if (above && start < above.start - TIME_SLACK_S) out.push(segProblem(s, i, 'order', SAY.outOfOrder(start, above), ['start']))
    if (duration !== undefined && duration > 0 && (end ?? start) > duration + TIME_SLACK_S) {
      out.push(segProblem(s, i, 'past-duration', SAY.pastDuration(start, end, duration), [end !== undefined ? 'end' : 'start']))
    }
    above = { name: segmentName(s, i), start }
  }
  return out
}

/** Where a segment is, in a message: its start time, else its place in the file. */
const placeOf = (x: { i: number; start: unknown }) => {
  const start = startOf({ start: x.start })
  return start !== undefined ? clockMs(start) : `#${x.i + 1}`
}

/** In time order: a segment starting before the one before it ends. */
function overlapProblems({ timed }: Checked): PodcastProblem[] {
  const out: PodcastProblem[] = []
  for (const [k, b] of timed.entries()) {
    const a = timed[k - 1]
    const aEnd = a && usableEnd(a.s, a.start)
    if (aEnd !== undefined && b.start < aEnd - TIME_SLACK_S) {
      out.push(segProblem(b.s, b.i, 'overlap', SAY.overlap(b.start, segmentName(a.s, a.i), aEnd), ['start']))
    }
  }
  return out
}

/** Sentence times, within the segment as the player times it (sentenceBound: the same end as resolveEpisode's). */
function sentenceProblems({ timed, podcast }: Checked): PodcastProblem[] {
  const out: PodcastProblem[] = []
  for (const [k, x] of timed.entries()) {
    if (x.s.sentences === undefined) continue
    const bad = sentencesProblem(x.s.sentences, x.start, sentenceBound(x.s, x.start, timed[k + 1]?.start, podcast.duration))
    if (bad) out.push(segProblem(x.s, x.i, 'sentences', SAY.sentences(bad.what), bad.sub))
  }
  return out
}

/** A timed segment's marks as marksProblems sees them: its text, and its times as the player has them. */
function marksIn(timed: TimedSegment[], k: number, duration: number | undefined) {
  const x = timed[k]
  const end = segmentEnd(x.s, x.start, timed[k + 1]?.start, duration)
  const text = typeof x.s.text === 'string' ? x.s.text : ''
  return marksProblems(x.s.marks, text, x.start, end, x.s.at === null)
}

/** Marks: their shape, time and phrase, within the segment as the player times it. */
function markShapeProblems({ timed, podcast }: Checked): PodcastProblem[] {
  const out: PodcastProblem[] = []
  for (const [k, x] of timed.entries()) {
    if (x.s.marks === undefined) continue
    for (const p of marksIn(timed, k, podcast.duration)) out.push(segProblem(x.s, x.i, 'mark', p.what, p.sub))
  }
  return out
}

/** A step's first mention in the narration: its id, its index in the journey, the segment. */
interface FirstMention extends IndexedSegment { step: string; k: number }

/**
 * The narration against the journey's order: the steps in the order the podcast first talks about them should
 * be the journey's. Reordered since (an agent rewrote the journey): one warning, at the first step out of order.
 */
function narrationOrder({ timed, ctx }: Checked): PodcastProblem[] {
  if (!ctx.journey) return []
  const index = new Map(ctx.journey.steps.map((s, k) => [s.id, k]))
  const firsts: FirstMention[] = []
  for (const { s, i } of timed) {
    const step = isObj(s.at) && typeof s.at.step === 'string' ? s.at.step : undefined
    const k = step === undefined ? undefined : index.get(step)
    if (step === undefined || k === undefined || firsts.some((f) => f.step === step)) continue
    firsts.push({ step, k, s, i })
  }
  const late = firsts.filter((f, n) => n > 0 && f.k < firsts[n - 1].k)
  if (!late.length) return []
  const f = late[0]
  const before = firsts[firsts.indexOf(f) - 1]
  return [segProblem(f.s, f.i, 'narration-order', SAY.narrationOrder(f, before, late.length), ['at', 'step'])]
}

/**
 * The marks against the code: the file there, the lines in it, `match` (its `nth`) within the lines. Only marks the
 * player keeps, and only files `files` could read; a mark's file is its own, else its segment's (segmentFile).
 */
function markCodeProblems({ timed, ctx, podcast }: Checked): PodcastProblem[] {
  const { journey, files } = ctx
  if (!journey || !files) return []
  const steps = stepIndex(journey)
  const lines = new Map<string, string[] | null | undefined>()
  const linesOf = (f: string) => {
    if (!lines.has(f)) { const t = files(f); lines.set(f, typeof t === 'string' ? t.split(/\r?\n/) : t) }
    return lines.get(f)
  }
  const out: PodcastProblem[] = []
  for (const [k, x] of timed.entries()) {
    if (!Array.isArray(x.s.marks)) continue
    const dropped = new Set(marksIn(timed, k, podcast.duration).filter((p) => p.drop).map((p) => p.k))
    const own = segmentFile(x.s, steps)
    // A beat the step doesn't have is said once (the step only is shown): the marks on its code are not checked
    // against the step's file instead (they would all be "not there").
    const badBeat = hasBadBeat(x.s, steps)
    for (const [n, m] of (x.s.marks as Record<string, unknown>[]).entries()) {
      if (dropped.has(n) || (badBeat && typeof m.file !== 'string')) continue
      const file = typeof m.file === 'string' ? m.file : own
      const doc = file ? linesOf(file) : undefined
      if (doc === undefined) continue
      const p = markCodeProblem({ doc, file, mark: codeMarkOf(m), onMissing: 'lines' })
      if (p) out.push(segProblem(x.s, x.i, 'mark', `mark ${n + 1}: ${p.what}`, ['marks', n, p.sub]))
    }
  }
  return out
}

/** Where each segment is shown (an unknown step, a beat the step doesn't have), when the journey is known. */
function linkProblems({ episode }: Checked): PodcastProblem[] {
  return episode?.problems ?? []
}

/** Recorded for an older commit, and steps' code changed since: a quiet line, nothing wrong with the file. */
function recordedFor({ podcast, ctx }: Checked): PodcastProblem[] {
  if (!podcast.journey.commit || !ctx.changed?.length) return []
  return [info('recorded-for', SAY.recordedFor(ctx.changed), ['journey', 'commit'])]
}

/** The segments and the declared duration against the audio's real length, once known. */
function audioLengthProblems({ written, podcast, ctx }: Checked): PodcastProblem[] {
  const audioLen = ctx.audioDuration
  if (audioLen === undefined || !(audioLen > 0)) return []
  const duration = podcast.duration
  const ends = written.map(({ s }) => num(s.end) ?? num(s.start)).filter((x): x is number => x !== undefined)
  const episodeLen = Math.max(duration ?? 0, ...ends, 0)
  const slack = Math.max(DURATION_SLACK_S, audioLen * DURATION_SLACK_SHARE)
  const past = written.filter(({ s }) => (num(s.start) ?? -1) >= audioLen)
  // Cut off: one plain sentence, not a warning per part.
  if (episodeLen > audioLen + Math.max(CUT_OFF_S, slack) && past.length) {
    return [warning('audio-short', SAY.cutOff(audioLen, episodeLen, past.length), ['audio'])]
  }
  const out: PodcastProblem[] = []
  if (duration !== undefined && Math.abs(duration - audioLen) > slack) {
    out.push(warning('duration', SAY.durationVsAudio(duration, audioLen), ['duration']))
  }
  for (const { s, i } of written) {
    const end = num(s.end)
    if (end !== undefined && end > audioLen + slack) out.push(segProblem(s, i, 'past-audio', SAY.pastAudio(end, audioLen), ['end']))
  }
  return out
}

/**
 * A step the journey doesn't have (deleted, or its id changed) said once, not once per segment about it: which
 * segments and when. On the first of them (problems are in time order); `segments` lists them all.
 */
function missingStepsOnce(problems: PodcastProblem[], written: IndexedSegment[]): PodcastProblem[] {
  const byIndex = new Map(written.map((x) => [x.i, x]))
  /** Each `step` problem's step id, and each missing step's segments in time order. */
  const stepOf = new Map<PodcastProblem, string>()
  const segmentsOf = new Map<string, IndexedSegment[]>()
  for (const p of problems) {
    const w = p.code === 'step' ? byIndex.get(p.path[1] as number) : undefined
    const at = w?.s.at
    if (!w || !isObj(at) || typeof at.step !== 'string') continue
    stepOf.set(p, at.step)
    segmentsOf.set(at.step, [...(segmentsOf.get(at.step) ?? []), w])
  }
  return problems.flatMap((p) => {
    const step = stepOf.get(p)
    if (step === undefined) return [p]
    const segs = segmentsOf.get(step)!
    return segs[0].i === p.path[1] ? [missingStep(step, segs)] : []
  })
}

/** One problem for step id `step`, which segments `segs` (in time order) name and the journey doesn't have. */
function missingStep(step: string, segs: IndexedSegment[]): PodcastProblem {
  const names = segs.map((x) => segmentName(x.s, x.i))
  const first = segs[0], last = segs[segs.length - 1]
  const from = num(first.s.start) ?? 0
  const to = num(last.s.end) ?? num(last.s.start) ?? from
  return {
    level: 'warning', code: 'step', path: ['segments', first.i, 'at', 'step'], segment: names[0], segments: names,
    message: SAY.missingStep(step, names, from, to),
  }
}

/** The repository files a podcast's marks are in (each mark's own, else its segment's): what to read for the check. */
export function markFileNames(podcast: Podcast, journey: JourneyShape): string[] {
  const steps = stepIndex(journey)
  const out = new Set<string>()
  for (const s of podcast.segments) {
    if (!Array.isArray(s.marks)) continue
    for (const m of s.marks) {
      const f = isObj(m) && typeof m.file === 'string' ? m.file : segmentFile(s, steps)
      if (f) out.add(f)
    }
  }
  return [...out]
}

// ---------- what the panel and the Journeys view say ----------

/** How many segments can't be shown as written (an unknown step, a beat the step doesn't have, no "at"). */
export const brokenLinks = (problems: PodcastProblem[]) =>
  new Set(problems.filter((p) => LINK_CODES.has(p.code)).flatMap((p) => p.segments ?? [p.segment])).size

/**
 * One short line about what is wrong with a podcast that plays (undefined: nothing to say): how many problems the
 * Problems view lists for its file ("Show why" opens it); with none, that its code changed since it was recorded.
 */
export function playNotice(problems: PodcastProblem[]): string | undefined {
  const n = problems.filter((p) => p.level !== 'info').length
  if (n) return `${n} ${n === 1 ? 'problem' : 'problems'}`
  return problems.find((p) => p.code === 'recorded-for')?.message
}
