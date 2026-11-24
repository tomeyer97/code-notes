// Compact anchors (`v: 3`, docs/journey-format.md "In the repo"): a journey committed to the repo, and a check's
// questions, store the first and last lines of their code, its length and a hash, not the whole block, so they stay
// reviewable in a PR. The one implementation: the extension imports it and the understanding CLI bundles it.
//
//   { v: 3, head: "first ≤ 3 non-blank lines", tail: "last ≤ 2 non-blank lines", lines: 14,
//     hash: "first 12 hex of sha1(normalized text)", before: "1 line", after: "1 line" }
//
// Normalized text: each non-blank line through lines.ts `norm`, joined by "\n" (blank lines don't count, so
// reformatting and blank-line edits are not changes). A hash over every line's `norm` (blanks as "") is accepted too;
// an anchor without a hash is fresh wherever head and tail are found.
//
// Relocation (findCompact): candidate starts where the head lines match (non-blank lines, in order); for each, the
// ends where the tail matches with a length in the window `lengthWindow` gives; the best candidate by `rankCandidates`.
// Found, same hash: fresh; found, other hash: changed (shown at the new place); not found: gone. Full-text anchors
// are converted in memory (toCompact).
import { createHash } from 'crypto'
import { blank, lineIs, norm, weak } from './lines'
import type { Anchor, CompactAnchor, Loc } from './kinds'
import { isCompact } from './kinds'

export type { CompactAnchor, FullAnchor } from './kinds'
export { isCompact } from './kinds'
/** Either kind of anchor (kinds.ts `Anchor`). */
export type AnyAnchor = Anchor
export type Found = { state: 'fresh' | 'changed'; loc: Loc } | { state: 'gone' }

// ---------- tunables ----------

/** Non-blank lines kept at the start (`head`) and the end (`tail`) of the block. */
export const HEAD_LINES = 3
export const TAIL_LINES = 2
/** A candidate's length must be at least MIN_LEN_RATIO × the stored length… */
const MIN_LEN_RATIO = 0.5
/** …and at most MAX_LEN_RATIO × the stored length + MAX_LEN_SLACK lines (a short block may grow by a few lines). */
const MAX_LEN_RATIO = 1.5
const MAX_LEN_SLACK = 5
/** Hex digits of the sha1 kept as the hash. */
const HASH_HEX = 12

const sha = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').slice(0, HASH_HEX)

/** The hash of a block (spec: non-blank lines normalized, joined by "\n"). */
export function blockHash(block: string[]): string { return sha(block.map(norm).filter(Boolean).join('\n')) }
/** The other reading of "normalized full text" (every line, blanks as ""): accepted as the same code. */
export function blockHashAll(block: string[]): string { return sha(block.map(norm).join('\n')) }

/** The compact anchor of lines [start, end] (0-based, inclusive) of a file. */
export function compactOf(lines: string[], start: number, end: number): CompactAnchor | undefined {
  const block = lines.slice(start, end + 1)
  const solid = block.filter((l) => !blank(l))
  if (!solid.length) return undefined
  const b = nonBlank(lines, start - 1, -1)
  const a = nonBlank(lines, end + 1, 1)
  return {
    v: 3,
    head: solid.slice(0, HEAD_LINES).join('\n'),
    tail: solid.slice(-TAIL_LINES).join('\n'),
    lines: block.length,
    hash: blockHash(block),
    before: b >= 0 ? lines[b] : '',
    after: a < lines.length ? lines[a] : '',
  }
}

/** A full-text anchor as compact, in memory. Undefined for a step on blank lines (it has only its context). */
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

/** The nearest non-blank line from `i` on in direction `step` (-1 or 1); -1 or `lines.length` when there is none. */
function nonBlank(lines: string[], i: number, step: -1 | 1): number {
  let k = i
  while (k >= 0 && k < lines.length && blank(lines[k])) k += step
  return k
}

/** The lengths a block stored as `storedLen` lines may have now and still be the same block. */
export function lengthWindow(storedLen: number): { minLen: number; maxLen: number } {
  return { minLen: Math.max(1, Math.ceil(storedLen * MIN_LEN_RATIO)), maxLen: Math.floor(storedLen * MAX_LEN_RATIO + MAX_LEN_SLACK) }
}

/** Where a candidate may end, and the first non-blank line after it (for the context after). */
type CandidateEnd = { end: number; afterLine: number }

/**
 * Where the code starting at `start` (its head matched up to `headEnd`) may end: the lines where the tail matches,
 * with a length in [minLen, maxLen]. A range stored with blank lines at its end is tried at its stored length too
 * (as journey.py does), so trailing blank lines don't make a fresh anchor look moved.
 */
function candidateEnds(
  lines: string[], start: number, headEnd: number, tail: string[], storedLen: number, minLen: number, maxLen: number,
): CandidateEnd[] {
  const out: CandidateEnd[] = []
  const first = Math.max(headEnd, start + minLen - 1)
  const last = Math.min(lines.length - 1, start + maxLen - 1)
  for (let e = first; e <= last; e++) {
    if (norm(lines[e]) !== tail[tail.length - 1] || !backward(lines, e, tail, start)) continue
    const afterLine = nonBlank(lines, e + 1, 1)
    const stored = start + storedLen - 1
    const storedFits = stored > e && stored < lines.length && lines.slice(e + 1, stored + 1).every(blank)
    out.push({ end: e, afterLine })
    if (storedFits) out.push({ end: stored, afterLine })
  }
  return out
}

/** A place the anchor's code may be: its lines (0-based) and what ranks it (rankCandidates). */
type Candidate = {
  start: number
  end: number
  /** The block's hash is the stored one. */
  hash: boolean
  /** How far its length is from the stored length. */
  dLen: number
  /** How many of the context lines (before, after) match: 0-2. */
  ctx: number
  /** How far it starts from where the anchor was. */
  dist: number
}

/** The order of candidates, best first: one criterion per line, each deciding only when the ones above tie. */
export function rankCandidates(x: Candidate, y: Candidate): number {
  return Number(y.hash) - Number(x.hash) // the stored hash first
    || x.dLen - y.dLen // then the closest length
    || y.ctx - x.ctx // then more matching context
    || x.dist - y.dist // then nearer to where it was
}

/** Where a compact anchor's code is in `lines` now (0-based). `hint`: where it was (the stored or tracked place). */
export function findCompact(lines: string[], a: CompactAnchor, hint: number): Found {
  const head = a.head.split('\n').map(norm).filter(Boolean)
  const tail = a.tail.split('\n').map(norm).filter(Boolean)
  if (!head.length) return { state: 'gone' }
  if (!tail.length) tail.push(...head.slice(-TAIL_LINES))
  const storedLen = Math.max(1, a.lines)
  const { minLen, maxLen } = lengthWindow(storedLen)
  // Context that says something: '' for a weak line (it never matches).
  const before = weak(a.before) ? '' : norm(a.before)
  const after = weak(a.after) ? '' : norm(a.after)
  const cands: Candidate[] = []
  for (let start = 0; start < lines.length; start++) {
    if (norm(lines[start]) !== head[0]) continue
    const headEnd = forward(lines, start, head)
    if (headEnd === undefined) continue
    const ctxBefore = lineIs(lines, nonBlank(lines, start - 1, -1), before) ? 1 : 0
    for (const { end, afterLine } of candidateEnds(lines, start, headEnd, tail, storedLen, minLen, maxLen)) {
      const block = lines.slice(start, end + 1)
      const hash = !a.hash || blockHash(block) === a.hash || blockHashAll(block) === a.hash
      const ctx = ctxBefore + (lineIs(lines, afterLine, after) ? 1 : 0)
      cands.push({ start, end, hash, dLen: Math.abs(end - start + 1 - storedLen), ctx, dist: Math.abs(start - hint) })
    }
  }
  if (!cands.length) return { state: 'gone' }
  cands.sort(rankCandidates)
  const c = cands[0]
  return { state: c.hash ? 'fresh' : 'changed', loc: { start: c.start, end: c.end } }
}
