// Compact anchors (v3, docs/journey-format.md "In the repo"): a journey committed to the repo stores the first and
// last lines of a step's code, its length and a hash, not the whole block, so it stays reviewable in a PR.
//
//   { v: 3, head: "first ≤ 3 non-blank lines", tail: "last ≤ 2 non-blank lines", lines: 14,
//     hash: "first 12 hex of sha1(normalized text)", before: "1 line", after: "1 line" }
//
// Normalized text: each non-blank line through anchor.ts `norm`, joined by "\n" (blank lines don't count, so
// reformatting and blank-line edits are not changes). A hash over every line's `norm` (blanks as "") is accepted too;
// an anchor without a hash is fresh wherever head and tail are found.
//
// Relocation: candidate starts where the head lines match (non-blank lines, in order); for each, the end where the
// tail matches with a length within [lines·0.5, lines·1.5 + 5]; prefer an exact hash, then the closest line count,
// then the before/after context, then nearness to the stored place. Found, same hash: fresh; found, other hash:
// changed (shown at the new place); not found: gone. v2 full-text anchors are converted in memory (toCompact).
import { createHash } from 'crypto'
import { norm, Loc } from './anchor'

export interface CompactAnchor { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }
export type FullAnchor = { text: string; before: string; after: string }
export type AnyAnchor = CompactAnchor | FullAnchor
export type Found = { state: 'fresh' | 'changed'; loc: Loc } | { state: 'gone' }

export const HEAD_LINES = 3
export const TAIL_LINES = 2

export const isCompact = (a: AnyAnchor | undefined): a is CompactAnchor => !!a && (a as CompactAnchor).v === 3
const sha12 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12)
const blank = (s: string) => norm(s) === ''
/** Lines like `}` say nothing about where code is: no context. */
const weak = (s: string) => norm(s).length < 3

/** The hash of a block (spec: non-blank lines normalized, joined by "\n"). */
export function blockHash(block: string[]): string { return sha12(block.map(norm).filter(Boolean).join('\n')) }
/** The other reading of "normalized full text" (every line, blanks as ""): accepted as the same code. */
function blockHashAll(block: string[]): string { return sha12(block.map(norm).join('\n')) }

/** The compact anchor of lines [start, end] (0-based, inclusive) of a file. */
export function compactOf(lines: string[], start: number, end: number): CompactAnchor | undefined {
  const block = lines.slice(start, end + 1)
  const solid = block.filter((l) => !blank(l))
  if (!solid.length) return undefined
  let b = start - 1
  while (b >= 0 && blank(lines[b])) b--
  let a = end + 1
  while (a < lines.length && blank(lines[a])) a++
  return { v: 3, head: solid.slice(0, HEAD_LINES).join('\n'), tail: solid.slice(-TAIL_LINES).join('\n'), lines: block.length, hash: blockHash(block),
    before: b >= 0 ? lines[b] : '', after: a < lines.length ? lines[a] : '' }
}

/** A v2 anchor (the whole text) as v3, in memory. Undefined for a step on blank lines (it has only its context). */
export function toCompact(a: AnyAnchor): CompactAnchor | undefined {
  if (isCompact(a)) return a
  const text = a.text.split('\n')
  const solid = (s: string) => s.split('\n').filter((l) => !blank(l))
  const c = compactOf(text, 0, text.length - 1)
  if (!c) return undefined
  return { ...c, before: solid(a.before).pop() ?? '', after: solid(a.after)[0] ?? '' }
}

/** Non-blank lines from `i` on match `want` (normalized) in order. Returns the index of the last matched line. */
function forward(lines: string[], i: number, want: string[]): number | undefined {
  let k = i
  for (let w = 0; w < want.length; w++) {
    while (k < lines.length && blank(lines[k])) k++
    if (k >= lines.length || norm(lines[k]) !== want[w]) return undefined
    if (w < want.length - 1) k++
  }
  return k
}
/** Non-blank lines ending at `e` match `want` (normalized) in order, none before `floor`. */
function backward(lines: string[], e: number, want: string[], floor: number): boolean {
  let k = e
  for (let w = want.length - 1; w >= 0; w--) {
    while (k >= floor && blank(lines[k])) k--
    if (k < floor || norm(lines[k]) !== want[w]) return false
    k--
  }
  return true
}

/** Where a compact anchor's code is in `lines` now (0-based). `hint`: where it was (the stored or tracked place). */
export function findCompact(lines: string[], a: CompactAnchor, hint: number): Found {
  const head = a.head.split('\n').map(norm).filter(Boolean)
  const tail = a.tail.split('\n').map(norm).filter(Boolean)
  if (!head.length) return { state: 'gone' }
  if (!tail.length) tail.push(...head.slice(-TAIL_LINES))
  const L = Math.max(1, a.lines)
  const minLen = Math.max(1, Math.ceil(L * 0.5)), maxLen = Math.floor(L * 1.5 + 5)
  const before = weak(a.before) ? '' : norm(a.before), after = weak(a.after) ? '' : norm(a.after)
  type C = { start: number; end: number; hash: boolean; dLen: number; ctx: number; dist: number }
  const cands: C[] = []
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) !== head[0]) continue
    const headEnd = forward(lines, i, head)
    if (headEnd === undefined) continue
    let b = i - 1
    while (b >= 0 && blank(lines[b])) b--
    const ctxBefore = before && b >= 0 && norm(lines[b]) === before ? 1 : 0
    for (let e = Math.max(headEnd, i + minLen - 1); e <= Math.min(lines.length - 1, i + maxLen - 1); e++) {
      if (norm(lines[e]) !== tail[tail.length - 1] || !backward(lines, e, tail, i)) continue
      let f = e + 1
      while (f < lines.length && blank(lines[f])) f++
      const ctx = ctxBefore + (after && f < lines.length && norm(lines[f]) === after ? 1 : 0)
      // A range stored with blank lines at its end is tried at its stored length too (as journey.py does), so trailing
      // blank lines don't make a fresh anchor look moved.
      const stored = i + L - 1
      const ends = stored > e && stored < lines.length && lines.slice(e + 1, stored + 1).every(blank) ? [e, stored] : [e]
      for (const end of ends) {
        const block = lines.slice(i, end + 1)
        const hash = !a.hash || blockHash(block) === a.hash || blockHashAll(block) === a.hash
        cands.push({ start: i, end, hash, dLen: Math.abs(end - i + 1 - L), ctx, dist: Math.abs(i - hint) })
      }
    }
  }
  if (!cands.length) return { state: 'gone' }
  cands.sort((x, y) => Number(y.hash) - Number(x.hash) || x.dLen - y.dLen || y.ctx - x.ctx || x.dist - y.dist)
  const c = cands[0]
  return { state: c.hash ? 'fresh' : 'changed', loc: { start: c.start, end: c.end } }
}
