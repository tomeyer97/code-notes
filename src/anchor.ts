// Keeping a note on the code it was written about, without the vscode API (unit-tested in test/).
//
// A note stores the lines it was written on (anchor text) and a couple of lines around them (context). When the
// file changes:
//   - the anchor text is still at the tracked position                        -> fine
//   - it is elsewhere in the file with matching context (or long and unique)  -> the note moves there
//   - otherwise (code edited, deleted, or only found in an unrelated place)   -> stale, at its last position
// Lines are compared without whitespace and with one quote style, so reformatting does not make a note stale.
// A note on blank lines is anchored on its context alone.
//
// Following live edits (shift, swallows) is lineFollow.ts; what a stale step's code became (a diff, or removed) is
// staleDiff.ts.

/** 0-based, inclusive line range. */
export interface Loc { start: number; end: number }

export interface AnchorResult { loc: Loc; stale: boolean; moved: boolean }

/** What a line means for comparison: no whitespace, one quote style, no trailing; or,. */
export const norm = (s: string) => s.replace(/\s+/g, '').replace(/['`]/g, '"').replace(/[;,]+$/, '')

/** A line with nothing in it once normalized. */
export const blank = (s: string) => norm(s) === ''
/** Lines like `}` or `);` say nothing about where code is: they don't count as context. */
export const weak = (s: string) => norm(s).length < 3

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
      const at = lineOf(i)
      if (at >= 0 && at < lines.length && norm(lines[at]) === norm(ctx[i])) score++
    }
  }
  // Either side can run off either end: `start` may be past the end of a file that shrank.
  count(before, (i) => start - before.length + i)
  count(after, (i) => start + len + i)
  return { score, max }
}

/** A line long enough to be recognisable on its own (an import, a signature), unlike `return null` or `}`. */
const DISTINCT = 25

/**
 * Where the anchor text occurs now. A candidate needs matching context, unless the anchor is substantial (2+
 * non-blank lines, or one long line) and occurs exactly once: a short line like `return null` elsewhere is not the
 * same code, but a unique `import { a, b } from './x.js'` that moved on its own (import sorting) is.
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

/** A place the code may be now: its first line, and how many context lines match there. */
interface Candidate { at: number; score: number }

/** A candidate beats the best so far: a higher score, or the same score nearer to where the note was. */
function better(c: Candidate, best: Candidate | undefined, tracked: number): boolean {
  if (!best) return true
  if (c.score !== best.score) return c.score > best.score
  return Math.abs(c.at - tracked) < Math.abs(best.at - tracked)
}

/** A note on blank lines: where its context (the code around it) is now. */
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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * Where the note belongs in `lines` now. `tracked` is its current position (after following edits live, or as
 * stored on disk); `hint` is where to prefer a match when the anchor occurs several times.
 */
export function anchor(lines: string[], text: string, before: string, after: string, tracked: Loc, hint = tracked.start): AnchorResult {
  const anchorLines = text.split('\n')
  const len = anchorLines.length
  const beforeLines = before ? before.split('\n') : []
  const afterLines = after ? after.split('\n') : []
  const last = Math.max(0, lines.length - 1)
  // A note that can't be placed keeps its own size: live edits may have stretched `tracked` (C101).
  const stay = (stale: boolean, size = tracked.end - tracked.start + 1): AnchorResult => {
    const start = clamp(tracked.start, 0, last)
    return { loc: { start, end: clamp(start + Math.max(1, size) - 1, start, last) }, stale, moved: false }
  }
  const at = (start: number): AnchorResult => {
    const loc = { start, end: start + len - 1 }
    return { loc, stale: false, moved: loc.start !== tracked.start || loc.end !== tracked.end }
  }

  if (anchorLines.every(blank)) {
    const here = contextScore(lines, tracked.start, len, beforeLines, afterLines)
    if (here.max === 0) return stay(false) // nothing around it to follow (an empty file)
    if (here.score === here.max && matchesAt(lines, anchorLines, tracked.start)) return at(tracked.start)
    const found = relocateByContext(lines, len, beforeLines, afterLines, hint)
    if (found) return found.exact ? at(found.at) : { ...at(found.at), stale: true }
    return stay(true)
  }
  const found = relocate(lines, anchorLines, beforeLines, afterLines, hint)
  if (matchesAt(lines, anchorLines, tracked.start)) {
    // An identical copy here, but the note's own context is elsewhere (code deleted, then restored by undo): go back.
    const here = contextScore(lines, tracked.start, len, beforeLines, afterLines).score
    if (found !== undefined && found !== tracked.start && contextScore(lines, found, len, beforeLines, afterLines).score > here) return at(found)
    return at(tracked.start)
  }
  if (found !== undefined) return at(found)
  // Edited: stale, but on the lines it is most likely about now (a line inserted above must not shift it onto
  // other code), so what changed can be shown as what changed.
  const near = closest(lines, anchorLines, beforeLines, afterLines, tracked.start)
  if (near) return { loc: near, stale: true, moved: near.start !== tracked.start || near.end !== tracked.end }
  return stay(true, len)
}

/** How far (in lines) from where it was edited code is looked for. */
const SEARCH_WINDOW = 40
/** A line of the block counts when found this many lines from where it would be (an insertion inside it shifts the
 *  rest); it scores LINE_SLACK + 1 - distance, so a line in place counts most. */
const LINE_SLACK = 3
/** A context line that matches counts as much as this many block lines in place (context says it is the same code). */
const CONTEXT_WEIGHT = 2
/** The block's last recognisable line is looked for this far from where it would be, to find the block's end. */
const END_SLACK = 6

/** Line `k` of `lines` is `want` (normalized). */
const lineIs = (lines: string[], k: number, want: string) => k >= 0 && k < lines.length && norm(lines[k]) === want

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
