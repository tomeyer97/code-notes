// The full check of a podcast file (docs/podcast-format.md, "Validation"): every problem, its level and where it is in
// the file. One function, used by the player (whether it can play the file, and what to say in the panel and the
// Journeys view), the "Code Notes" output, the Problems view (diagnostics on the `.podcast.json`), and, ported rule
// for rule, by the code-journey skill's `journey.py podcast` (the cases in test/fixtures/podcast/cases.json run
// through both). No vscode here.

import { clock, clockMs, Episode, findMark, JourneyShape, LINK_CODES, MARK_REFIND_LINES, marksProblems, Podcast, PodcastProblem, resolveEpisode, segmentName, segProblem, sentenceBound, sentencesProblem, WrittenSegment } from './model'

/** What is known around the file: the journey next to it, its audio file (looked at or not), the audio's real length
 *  (once the panel has loaded it). */
export interface PodcastContext {
  journey?: JourneyShape & { id: string }
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
  if (ctx.journey) problems.push(...narrationOrder(written, ctx.journey))
  if (ctx.journey && ctx.files) problems.push(...markCodeProblems(written, ctx.journey, ctx.files, podcast.duration))
  // Where each segment is shown (an unknown step, a beat the step doesn't have: F30), when the journey is known.
  let episode: Episode | undefined
  if (ctx.journey) {
    episode = resolveEpisode(podcast, ctx.journey)
    // resolveEpisode's indexes are into podcast.segments: back to the file's.
    for (const p of episode.problems) {
      const k = p.path[1]
      if (typeof k === 'number') p.path = ['segments', written[k]?.i ?? k, ...p.path.slice(2)]
    }
    // Its start-time warnings are timingProblems' already; a step the journey doesn't have is said once (F45).
    episode.problems = missingStepsOnce(episode.problems.filter((p) => p.code !== 'start'), written)
    problems.push(...episode.problems)
    episode.warnings = episode.problems.map((p) => p.message)
  }
  // Recorded for an older commit, and steps' code changed since (F63): a quiet line, nothing wrong with the file.
  if (podcast.journey.commit && ctx.changed?.length) {
    const n = ctx.changed.length
    problems.push({ level: 'info', code: 'recorded-for', message: `recorded for ${podcast.journey.commit}; ${n} ${n === 1 ? 'step' : 'steps'} changed since (${n === 1 ? 'step' : 'steps'} ${ctx.changed.join(', ')})`, path: ['journey', 'commit'] })
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
  const ids = new Map<string, { i: number; start: unknown }>()
  let prevInFile: { name: string; start: number } | undefined
  const timed: { s: WrittenSegment; i: number; start: number; end?: number }[] = []
  for (const { s, i } of written) {
    const name = segmentName(s, i)
    if (typeof s.id === 'string' && s.id) {
      const first = ids.get(s.id)
      if (first) out.push(segProblem(s, i, 'id', `the id "${s.id}" is used twice (${placeOf(first)} and ${placeOf({ i, start: s.start })})`, ['id']))
      else ids.set(s.id, { i, start: s.start })
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
  // Sentence times, within the segment as the player times it (sentenceBound: the same end as resolveEpisode's).
  sorted.forEach((x, k) => {
    if (x.s.sentences === undefined) return
    const bad = sentencesProblem(x.s.sentences, x.start, sentenceBound(x.s, x.start, sorted[k + 1]?.start, duration))
    if (bad) out.push(segProblem(x.s, x.i, 'sentences', `${bad.what}; the caption is estimated from the text instead`, bad.sub))
  })
  // Marks (their shape, time, phrase), within the segment as the player times it (resolveEpisode's end).
  sorted.forEach((x, k) => {
    if (x.s.marks === undefined) return
    const end = Math.max(num(x.s.end) ?? sorted[k + 1]?.start ?? duration ?? x.start, x.start)
    const text = typeof x.s.text === 'string' ? x.s.text : ''
    for (const p of marksProblems(x.s.marks, text, x.start, end, x.s.at === null)) out.push(segProblem(x.s, x.i, 'mark', p.what, p.sub))
  })
  return out
}

/**
 * The marks against the code (F-marks): the file there, the lines in it, `match` (its `nth`) within the lines. Only
 * marks the player keeps, and only files `files` could read; a mark's file is its own, else its segment's beat's,
 * else its step's (as the journey says).
 */
function markCodeProblems(written: { s: WrittenSegment; i: number }[], journey: JourneyShape & { id: string }, files: (path: string) => string | null | undefined, duration: number | undefined): PodcastProblem[] {
  const out: PodcastProblem[] = []
  const byId = new Map(journey.steps.map((s) => [s.id, s]))
  const timed = written.map((x) => ({ ...x, start: num(x.s.start) })).filter((x) => x.start !== undefined && x.start >= 0).sort((a, b) => a.start! - b.start! || a.i - b.i)
  const docs = new Map<string, string[] | null | undefined>()
  const doc = (f: string) => {
    if (!docs.has(f)) { const t = files(f); docs.set(f, typeof t === 'string' ? t.split(/\r?\n/) : t) }
    return docs.get(f)
  }
  timed.forEach((x, k) => {
    if (!Array.isArray(x.s.marks)) return
    const end = Math.max(num(x.s.end) ?? timed[k + 1]?.start ?? duration ?? x.start!, x.start!)
    const text = typeof x.s.text === 'string' ? x.s.text : ''
    const dropped = new Set(marksProblems(x.s.marks, text, x.start!, end, x.s.at === null).filter((p) => p.drop).map((p) => p.k))
    const own = ownFile(x.s, byId)
    ;(x.s.marks as Record<string, unknown>[]).forEach((m, n) => {
      if (dropped.has(n)) return
      const file = typeof m.file === 'string' ? m.file : own
      if (!file) return
      const lines = doc(file)
      const say = (what: string, sub: string) => out.push(segProblem(x.s, x.i, 'mark', `mark ${n + 1}: ${what}`, ['marks', n, sub]))
      if (lines === undefined) return
      if (lines === null) { say(`${file} isn't in the repository; nothing is lit`, typeof m.file === 'string' ? 'file' : 'lines'); return }
      const [a, b] = m.lines as number[]
      const where = `${a === b ? `line ${a}` : `lines ${a}–${b}`} of ${file}`
      if (b > lines.length) { say(`${where} ${a > lines.length ? (a === b ? 'is' : 'are') : 'go'} past its end (${lines.length} lines)${a > lines.length ? '; nothing is lit' : ''}`, 'lines'); return }
      if (typeof m.match !== 'string') return
      const f = findMark(lines, { lines: [a, b], match: m.match, nth: typeof m.nth === 'number' ? m.nth : undefined })
      if (!f || f.moved === 0 && f.found) return
      const what = `${JSON.stringify(m.match)}${typeof m.nth === 'number' && m.nth > 1 ? ` (occurrence ${m.nth})` : ''} isn't in ${where}`
      if (f.found) say(`${what}; found ${Math.abs(f.moved)} ${Math.abs(f.moved) === 1 ? 'line' : 'lines'} ${f.moved < 0 ? 'up' : 'down'}, lit there`, 'match')
      else say(`${what}, nor within ${MARK_REFIND_LINES} lines: the whole lines light`, 'match')
    })
  })
  return out
}

/** The repository files a podcast's marks are in (each mark's own, else its segment's): what to read for the check. */
export function markFileNames(podcast: Podcast, journey: JourneyShape): string[] {
  const byId = new Map(journey.steps.map((s) => [s.id, s]))
  const out = new Set<string>()
  for (const s of podcast.segments) {
    if (!Array.isArray(s.marks)) continue
    for (const m of s.marks) {
      const f = isObj(m) && typeof m.file === 'string' ? m.file : ownFile(s, byId)
      if (f) out.add(f)
    }
  }
  return [...out]
}

/** The file a segment shows (a mark's default): its beat's code file, else its step's; '' when the journey doesn't say. */
function ownFile(s: WrittenSegment, byId: Map<string, JourneyShape['steps'][number]>): string {
  const at = s.at
  if (!isObj(at) || typeof at.step !== 'string') return ''
  const st = byId.get(at.step)
  if (!st) return ''
  const b = at.beat
  const beatFile = s.cue !== 'map' && typeof b === 'number' && Number.isInteger(b) && b >= 1 ? st.beatFiles?.[b - 1] : undefined
  return beatFile ?? st.file ?? ''
}

/** Where a segment is, in a message: its start time, else its place in the file. */
const placeOf = (x: { i: number; start: unknown }) => (num(x.start) !== undefined && num(x.start)! >= 0 ? clockMs(num(x.start)!) : `#${x.i + 1}`)

/**
 * A step the journey doesn't have (deleted, or its id changed) said once, not once per segment about it: which
 * segments and when (F45). On the first of them; `segments` lists them all.
 */
function missingStepsOnce(problems: PodcastProblem[], written: { s: WrittenSegment; i: number }[]): PodcastProblem[] {
  const byStep = new Map<string, { s: WrittenSegment; i: number }[]>()
  const atStep = (p: PodcastProblem) => {
    const w = written.find((x) => x.i === p.path[1])
    const at = w?.s.at as { step?: unknown } | undefined
    return w && typeof at?.step === 'string' ? { w, step: at.step } : undefined
  }
  for (const p of problems) {
    const a = p.code === 'step' ? atStep(p) : undefined
    if (a) byStep.set(a.step, [...(byStep.get(a.step) ?? []), a.w])
  }
  const out: PodcastProblem[] = []
  for (const p of problems) {
    const a = p.code === 'step' ? atStep(p) : undefined
    if (!a) { out.push(p); continue }
    const segs = byStep.get(a.step)!
    if (segs[0] !== a.w) continue
    out.push(missingStep(a.step, segs))
  }
  return out
}

/** One problem for step id `step`, which segments `segs` (in time order) name and the journey doesn't have. */
function missingStep(step: string, segs: { s: WrittenSegment; i: number }[]): PodcastProblem {
  const names = segs.map((x) => segmentName(x.s, x.i))
  const first = segs[0], last = segs[segs.length - 1]
  const from = num(first.s.start) ?? 0
  const to = num(last.s.end) ?? num(last.s.start) ?? from
  const which = names.length === 1 ? `segment ${names[0]}` : `segments ${names[0]}–${names[names.length - 1]}`
  const keep = names.length === 1 ? 'it keeps the view before it' : 'they keep the view before them'
  return {
    level: 'warning', code: 'step', path: ['segments', first.i, 'at', 'step'], segment: names[0], segments: names,
    message: `step "${step}" isn't in the journey (${which}, ${clockMs(from)}–${clockMs(to)}): ${keep}`,
  }
}

/**
 * The narration against the journey's order (F103): the steps in the order the podcast first talks about them should
 * be the journey's. Reordered since (an agent rewrote the journey): one warning, at the first step out of order.
 */
function narrationOrder(written: { s: WrittenSegment; i: number }[], journey: JourneyShape): PodcastProblem[] {
  const index = new Map(journey.steps.map((s, k) => [s.id, k]))
  const firsts: { step: string; k: number; start: number; s: WrittenSegment; i: number }[] = []
  const timed = written.map((x) => ({ ...x, start: num(x.s.start) })).filter((x) => x.start !== undefined && x.start >= 0)
    .sort((a, b) => a.start! - b.start! || a.i - b.i)
  for (const x of timed) {
    const at = x.s.at as { step?: unknown } | null | undefined
    const step = at && typeof at === 'object' && typeof at.step === 'string' ? at.step : undefined
    const k = step === undefined ? undefined : index.get(step)
    if (step === undefined || k === undefined || firsts.some((f) => f.step === step)) continue
    firsts.push({ step, k, start: x.start!, s: x.s, i: x.i })
  }
  const late = firsts.filter((f, n) => n > 0 && f.k < firsts[n - 1].k)
  if (!late.length) return []
  const f = late[0]
  const before = firsts[firsts.indexOf(f) - 1]
  const more = late.length > 1 ? ` (${late.length} steps out of order)` : ''
  return [segProblem(f.s, f.i, 'narration-order', `narrates step ${f.k + 1} ("${f.step}") after step ${before.k + 1} ("${before.step}"): the journey's steps were reordered since it was recorded; re-record it, or put the steps back${more}`, ['at', 'step'])]
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

// ---------- what the panel and the Journeys view say ----------

/** How many segments can't be shown as written (an unknown step, a beat the step doesn't have, no "at"). */
export const brokenLinks = (problems: PodcastProblem[]) => new Set(problems.filter((p) => LINK_CODES.has(p.code)).flatMap((p) => p.segments ?? [p.segment])).size

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
  if (problems.some((p) => p.code === 'narration-order')) parts.push("Narrated in another order than the journey's")
  const said = new Set(['audio-short', 'journey', 'narration-order'])
  const rest = problems.filter((p) => p.level === 'warning' && !said.has(p.code) && !LINK_CODES.has(p.code)).length
  if (rest && parts.length < 2) parts.push(`${rest} ${rest === 1 ? 'problem' : 'problems'} in the podcast file`)
  // Quiet, and only when nothing else is said: recorded for an older commit.
  const recorded = problems.find((p) => p.code === 'recorded-for')
  if (recorded && !parts.length) parts.push(recorded.message.replace(/^recorded/, 'Recorded').replace(/ \(steps? [\d, ]+\)$/, ''))
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
