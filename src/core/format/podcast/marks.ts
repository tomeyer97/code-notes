// A segment's marks: word-timed highlights within a segment (docs/podcast-format.md, "Marks"): which ones are usable,
// when each lights, which are lit at a second, and which open another file. Pure.

import { codeMarkOf, MarkProblem, markShapeProblem } from '../marks'
import { clockMs } from '../../clock'
import type { Mark, SegmentIssue } from './format'
import { isObj, num, TIME_SLACK_S } from './guards'
import { VIEW_HOLD_S } from './timeline'

/** A mark lights this long before its `at` (s): the eye gets there as the word is said, not after it. */
export const MARK_LEAD_S = 0.12

const round2 = (t: number) => Math.round(t * 100) / 100

/** The segment a mark is checked in: its text and its times as the player has them; `onMap`: its `at` is null (a
 *  mark then needs its own `file`). */
interface MarkSegment { text: string; start: number; end: number; onMap: boolean }

/** Why mark `m` can't be used (it is dropped), or undefined. */
function unusable(m: unknown, seg: MarkSegment): SegmentIssue | undefined {
  if (!isObj(m)) return { what: 'not an object { phrase, at, lines }', sub: [] }
  if (typeof m.phrase !== 'string' || !m.phrase.trim()) return { what: 'no phrase', sub: m.phrase === undefined ? [] : ['phrase'] }
  const at = num(m.at)
  if (at === undefined) {
    return m.at === undefined
      ? { what: 'no "at" (seconds from the segment\'s start)', sub: [] }
      : { what: `at ${JSON.stringify(m.at)} is not a time in seconds`, sub: ['at'] }
  }
  const len = Math.max(0, seg.end - seg.start)
  if (at < -TIME_SLACK_S || at > len + TIME_SLACK_S) {
    const where = `outside the segment (${clockMs(seg.start)}–${clockMs(seg.end)})`
    return { what: `at ${clockMs(seg.start + at)} (${round2(at)} s) is ${where}`, sub: ['at'] }
  }
  const shape = markShapeProblem(m)
  if (shape) return shape
  if (m.file === undefined && seg.onMap) return { what: 'a mark in a segment on the map ("at": null) needs its own "file"', sub: [] }
  return undefined
}

/**
 * What is wrong with a segment's `marks` (validate.ts says it; resolveEpisode leaves out the marks it names: `drop`).
 * `start`, `end`: the segment's times as the player has them; `onMap`: the segment's `at` is null (a mark then needs
 * its own `file`). A usable mark can still be worth a word: out of order (they light in time order), or a phrase
 * that isn't in the text.
 */
export function marksProblems(v: unknown, text: string, start: number, end: number, onMap: boolean): MarkProblem[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) return [{ what: 'marks is not a list of { phrase, at, lines }; ignored', sub: ['marks'], drop: true }]
  const seg: MarkSegment = { text, start, end, onMap }
  const out: MarkProblem[] = []
  /** The last usable mark: when it lights, its phrase, and where that phrase is in the text (-1: not there). */
  let prev: { at: number; phrase: string; pos: number } | undefined
  /** Where in the text the next phrase is looked for: after the phrase before it. */
  let from = 0
  for (const [k, m] of v.entries()) {
    const bad = unusable(m, seg)
    if (bad) {
      out.push({ k, what: `mark ${k + 1}: ${bad.what}; ignored`, sub: ['marks', k, ...bad.sub], drop: true })
      continue
    }
    const { phrase, at } = m as { phrase: string; at: number }
    if (prev && at < prev.at - TIME_SLACK_S) {
      const what = `mark ${k + 1} lights at ${round2(at)} s, before mark ${k} (${round2(prev.at)} s): marks light in the order they are said`
      out.push({ k, what, sub: ['marks', k, 'at'], drop: false })
    }
    // The same phrase as the mark before: the same words (two places at once).
    const pos = phrase === prev?.phrase ? prev.pos : text.indexOf(phrase, from)
    if (pos < 0) {
      const what = `mark ${k + 1}: the phrase ${JSON.stringify(phrase)} isn't in the text${from ? ' after the phrase before it' : ''}`
      out.push({ k, what, sub: ['marks', k, 'phrase'], drop: false })
    } else from = pos + phrase.length
    prev = { at, phrase, pos }
  }
  return out
}

/** A segment's usable marks (marksProblems' dropped ones left out), in the order they light. */
export function marksOf(v: unknown, text: string, start: number, end: number, onMap: boolean): Mark[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined
  const drop = new Set(marksProblems(v, text, start, end, onMap).filter((p) => p.drop).map((p) => p.k))
  const out: Mark[] = []
  for (const [k, m] of v.entries()) {
    if (drop.has(k)) continue
    const x = m as Record<string, unknown>
    out.push({ phrase: x.phrase as string, at: x.at as number, ...codeMarkOf(x) })
  }
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
 * Which of a segment's marks light (the view hold, for marks): a mark in the file on screen lights; one in
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
