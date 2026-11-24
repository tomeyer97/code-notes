// What a stale step's or note's code became: edited in place (a diff of what was there and what is there now) or
// removed. No vscode API (unit-tested in test/anchor.test.ts and test/journeyModel.test.ts). Finding the code is
// anchor.ts.
import { norm } from './anchor'

/** Blocks longer than this (lines before × lines after) are not diffed: all of one is removed, all of the other added. */
const MAX_DIFF_CELLS = 250_000

/** The lines removed and added between two versions of a block (a longest-common-subsequence diff). */
export function lineDiff(a: string[], b: string[]): { del: string[]; ins: string[] } {
  if (a.length * b.length > MAX_DIFF_CELLS) return { del: a, ins: b }
  const n = a.length, m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = norm(a[i]) === norm(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const del: string[] = [], ins: string[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (norm(a[i]) === norm(b[j])) {
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) del.push(a[i++])
    else ins.push(b[j++])
  }
  while (i < n) del.push(a[i++])
  while (j < m) ins.push(b[j++])
  return { del, ins }
}

/** Lines this short once normalized (`}`, `return`) say nothing about which code a stale step was. */
const TELLING_LENGTH = 3
/** Lines around the step's old place looked at (above and below). */
const NEAR_LINES = 3
/** Edited in place, not removed: this share of its telling lines is still near its place… */
const KEPT_SHARE = 0.4
/** …or this share of its context lines, and at least one of its own. */
const CONTEXT_KEPT_SHARE = 0.75

/**
 * A stale step: edited in place (most of its lines, or the lines around it, are still there: a diff) or removed (its
 * code is not near its old place any more).
 */
export function staleKind(lines: string[], a: { text: string; before: string; after: string }, loc: { start: number; end: number }): { removed?: boolean; was?: string; now?: string } {
  const want = a.text.split('\n').map(norm).filter((l) => l.length > TELLING_LENGTH)
  const lo = Math.max(0, loc.start - NEAR_LINES)
  const hi = Math.min(lines.length, loc.end + NEAR_LINES + 1)
  const near = new Set(lines.slice(lo, hi).map(norm))
  const kept = want.filter((l) => near.has(l)).length
  const ctx = [...a.before.split('\n'), ...a.after.split('\n')].map(norm).filter(Boolean)
  // Context may have moved a little further out than the step's own lines.
  const wider = lines.slice(Math.max(0, lo - NEAR_LINES), hi + NEAR_LINES).map(norm)
  const ctxKept = ctx.filter((l) => near.has(l) || wider.includes(l)).length
  const mostKept = want.length > 0 && kept / want.length >= KEPT_SHARE
  const contextKept = ctx.length > 0 && ctxKept / ctx.length >= CONTEXT_KEPT_SHARE && kept > 0
  const edited = want.length > 0 && (mostKept || contextKept)
  if (!edited) return { removed: true }
  return { was: a.text, now: lines.slice(loc.start, Math.min(lines.length, loc.end + 1)).join('\n') }
}
