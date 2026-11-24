// Full-text anchors: keeping a note on the code it was written about, without the vscode API (unit-tested in test/).
//
// A note stores the lines it was written on (anchor text) and a couple of lines around them (context). When the
// file changes, `anchor` tries these in order (one function each, below):
//   onBlankLines    a note on blank lines follows its context alone
//   stillHere       the anchor text is still at the tracked position                       -> fine
//   movedElsewhere  it is elsewhere with matching context (or long and unique)             -> the note moves there
//   editedNearby    the code was edited: stale, on the lines it is most likely about now
//   otherwise       deleted, or only found in an unrelated place                           -> stale, where it was
// Lines are compared through lines.ts `norm`, so reformatting does not make a note stale.
//
// Three scans look for candidates; each keeps the best by `better` (more context, then nearer):
//   relocate          the exact text anywhere in the file (movedElsewhere)
//   relocateByContext blank lines whose context matches (onBlankLines)
//   closest           offsets near the tracked place, scored line by line (editedNearby)
//
// Compact anchors (journeys, the check) are compact.ts; following live edits is lineFollow.ts; what a stale note's
// code became is staleDiff.ts. README.md lists every engine's tunables.
import { blank, lineIs, norm, weak } from './lines'
import type { Loc } from './kinds'

export type { Loc } from './kinds'
export { blank, norm, weak } from './lines'

// ---------- tunables ----------

/** relocate: a line this long once normalized is recognisable on its own (an import, a signature), unlike `}`. */
const DISTINCT = 25
/** closest: how far (in lines) from where it was edited code is looked for. */
const SEARCH_WINDOW = 40
/** closest: a line of the block counts when found this many lines from where it would be (an insertion inside it
 *  shifts the rest); it scores LINE_SLACK + 1 - distance, so a line in place counts most. */
const LINE_SLACK = 3
/** closest: a context line that matches counts as much as this many block lines in place. */
const CONTEXT_WEIGHT = 2
/** closest: the block's last recognisable line is looked for this far from where it would be, to find its end. */
const END_SLACK = 6

export interface AnchorResult { loc: Loc; stale: boolean; moved: boolean }

export function matchesAt(lines: string[], anchor: string[], start: number): boolean {
  if (start < 0 || start + anchor.length > lines.length) return false
  for (let i = 0; i < anchor.length; i++) if (norm(lines[start + i]) !== norm(anchor[i])) return false
  return true
}

/** Context lines (non-blank ones only) that match around a block of `len` lines at `start`, and how many could. */
export function contextScore(lines: string[], start: number, len: number, before: string[], after: string[]): { score: number; max: number } {
  let score = 0, max = 0
  /** Context lines `ctx`, the i-th expected at line `lineOf(i)`, when that line is in the file. */
  const count = (ctx: string[], lineOf: (i: number) => number) => {
    for (let i = 0; i < ctx.length; i++) {
      if (weak(ctx[i])) continue
      max++
      if (lineIs(lines, lineOf(i), norm(ctx[i]))) score++
    }
  }
  // Either side can run off either end: `start` may be past the end of a file that shrank.
  count(before, (i) => start - before.length + i)
  count(after, (i) => start + len + i)
  return { score, max }
}

/** A place the code may be now: its first line, and how many context lines match there. */
interface Candidate { at: number; score: number }

/** A candidate beats the best so far: a higher score, or the same score nearer to where the note was. */
function better(c: Candidate, best: Candidate | undefined, tracked: number): boolean {
  if (!best) return true
  if (c.score !== best.score) return c.score > best.score
  return Math.abs(c.at - tracked) < Math.abs(best.at - tracked)
}

// ---------- the three scans ----------

/**
 * Where the anchor text occurs now. A candidate needs matching context, unless the anchor is substantial (2+
 * non-blank lines, or one long line) and occurs exactly once: a short line like `return null` elsewhere is not the
 * same code, but a unique `import { a, b } from '../../x.js'` that moved on its own (import sorting) is.
 */
export function relocate(lines: string[], anchor: string[], before: string[], after: string[], hint: number): number | undefined {
  if (!anchor.length || anchor.every(blank)) return undefined
  const first = norm(anchor[0])
  const found: Candidate[] = []
  for (let i = 0; i + anchor.length <= lines.length; i++) {
    if (norm(lines[i]) !== first || !matchesAt(lines, anchor, i)) continue
    found.push({ at: i, score: contextScore(lines, i, anchor.length, before, after).score })
  }
  const recognisable = anchor.filter((l) => !weak(l)).length >= 2
  const oneLongLine = anchor.length === 1 && norm(anchor[0]).length >= DISTINCT
  const substantial = recognisable || oneLongLine
  let best: Candidate | undefined
  for (const c of found) {
    const ok = c.score > 0 || (substantial && found.length === 1)
    if (ok && better(c, best, hint)) best = c
  }
  return best?.at
}

/** A note on blank lines: where its context (the code around it) is now; `exact`: all of it matches there. */
function relocateByContext(lines: string[], len: number, before: string[], after: string[], tracked: number): { at: number; exact: boolean } | undefined {
  let best: Candidate | undefined
  let max = 0
  for (let i = 0; i + len <= lines.length; i++) {
    let allBlank = true
    for (let k = 0; k < len; k++) if (!blank(lines[i + k])) { allBlank = false; break }
    if (!allBlank) continue
    const c = contextScore(lines, i, len, before, after)
    max = c.max
    if (c.score === 0) continue
    const cand = { at: i, score: c.score }
    if (better(cand, best, tracked)) best = cand
  }
  if (!best) return undefined
  return { at: best.at, exact: best.score === max }
}

/** How much the block line `want` (normalized; '' says nothing) counts when it belongs at line `at`: more the nearer it is found. */
function lineScore(lines: string[], at: number, want: string): number {
  if (!want) return 0
  for (let d = 0; d <= LINE_SLACK; d++) {
    if (lineIs(lines, at + d, want) || lineIs(lines, at - d, want)) return LINE_SLACK + 1 - d
  }
  return 0
}

/** The last line of a block of `want.length` lines found at `start`: where its last recognisable line is now, if close. */
function blockEnd(lines: string[], start: number, want: string[]): number {
  const len = want.length
  const lastI = want.map((w, i) => (w ? i : -1)).filter((i) => i >= 0).pop()
  if (lastI === undefined) return start + len - 1
  for (let d = 0; d <= END_SLACK; d++) {
    const hit = [start + lastI + d, start + lastI - d].find((k) => k >= start && lineIs(lines, k, want[lastI]))
    if (hit !== undefined) return hit + (len - 1 - lastI)
  }
  return start + len - 1
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Where edited code most likely is now: the offset near `tracked` that keeps most of its (and its context's) lines. */
export function closest(lines: string[], anchor: string[], before: string[], after: string[], tracked: number, window = SEARCH_WINDOW): Loc | undefined {
  const len = anchor.length
  const want = anchor.map((l) => (weak(l) ? '' : norm(l)))
  let best: Candidate | undefined
  for (let at = Math.max(0, tracked - window); at <= Math.min(lines.length - 1, tracked + window); at++) {
    let score = 0
    for (let i = 0; i < len; i++) score += lineScore(lines, at + i, want[i])
    score += contextScore(lines, at, len, before, after).score * CONTEXT_WEIGHT
    const cand = { at, score }
    if (score > 0 && better(cand, best, tracked)) best = cand
  }
  if (!best) return undefined
  const end = blockEnd(lines, best.at, want)
  return { start: best.at, end: clamp(end, best.at, Math.max(best.at, lines.length - 1)) }
}

// ---------- anchor: the strategies, tried in order ----------

/** What every strategy looks at: the file now, the note's anchor split into lines, where it is tracked. */
interface Search {
  lines: string[]
  text: string[]
  before: string[]
  after: string[]
  tracked: Loc
  /** Where to prefer a match when the anchor occurs several times. */
  hint: number
}

/** The note on lines from `start`, as long as its anchor text. */
function at(s: Search, start: number): AnchorResult {
  const loc = { start, end: start + s.text.length - 1 }
  return { loc, stale: false, moved: loc.start !== s.tracked.start || loc.end !== s.tracked.end }
}

/** The note where it is tracked, clamped to the file. It keeps its own size (`size`): live edits may have stretched
 *  `tracked` while the code was being rewritten, and a note that can't be placed must not grow with them. */
function stay(s: Search, stale: boolean, size = s.tracked.end - s.tracked.start + 1): AnchorResult {
  const last = Math.max(0, s.lines.length - 1)
  const start = clamp(s.tracked.start, 0, last)
  return { loc: { start, end: clamp(start + Math.max(1, size) - 1, start, last) }, stale, moved: false }
}

/** A note on blank lines: anchored on its context alone. Undefined for any other note. */
function onBlankLines(s: Search): AnchorResult | undefined {
  if (!s.text.every(blank)) return undefined
  const len = s.text.length
  const here = contextScore(s.lines, s.tracked.start, len, s.before, s.after)
  if (here.max === 0) return stay(s, false) // nothing around it to follow (an empty file)
  if (here.score === here.max && matchesAt(s.lines, s.text, s.tracked.start)) return at(s, s.tracked.start)
  const found = relocateByContext(s.lines, len, s.before, s.after, s.hint)
  if (found) return found.exact ? at(s, found.at) : { ...at(s, found.at), stale: true }
  return stay(s, true)
}

/** The text is still where the note is tracked. An identical copy may be here while the note's own context is
 *  elsewhere (code deleted, then restored by undo): then the note goes back to the original. */
function stillHere(s: Search): AnchorResult | undefined {
  if (!matchesAt(s.lines, s.text, s.tracked.start)) return undefined
  const found = relocate(s.lines, s.text, s.before, s.after, s.hint)
  if (found === undefined || found === s.tracked.start) return at(s, s.tracked.start)
  const scoreAt = (start: number) => contextScore(s.lines, start, s.text.length, s.before, s.after).score
  return scoreAt(found) > scoreAt(s.tracked.start) ? at(s, found) : at(s, s.tracked.start)
}

/** The text moved: found elsewhere with its context (or long and unique). */
function movedElsewhere(s: Search): AnchorResult | undefined {
  const found = relocate(s.lines, s.text, s.before, s.after, s.hint)
  return found === undefined ? undefined : at(s, found)
}

/** The code was edited: stale, but on the lines it is most likely about now (a line inserted above must not shift it
 *  onto other code), so what changed can be shown as what changed. */
function editedNearby(s: Search): AnchorResult | undefined {
  const near = closest(s.lines, s.text, s.before, s.after, s.tracked.start)
  if (!near) return undefined
  return { loc: near, stale: true, moved: near.start !== s.tracked.start || near.end !== s.tracked.end }
}

const STRATEGIES = [onBlankLines, stillHere, movedElsewhere, editedNearby]

/**
 * Where the note belongs in `lines` now. `tracked` is its current position (after following edits live, or as
 * stored on disk); `hint` is where to prefer a match when the anchor occurs several times.
 */
export function anchor(lines: string[], text: string, before: string, after: string, tracked: Loc, hint = tracked.start): AnchorResult {
  const s: Search = {
    lines,
    text: text.split('\n'),
    before: before ? before.split('\n') : [],
    after: after ? after.split('\n') : [],
    tracked,
    hint,
  }
  for (const strategy of STRATEGIES) {
    const r = strategy(s)
    if (r) return r
  }
  // Deleted, or only found in an unrelated place: stale where it was, as long as its text.
  return stay(s, true, s.text.length)
}
