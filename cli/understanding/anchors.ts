// Compact anchors: a question's lines found again after the code moved. The same format and rules as the
// extension's src/core/anchors/compact.ts (a second implementation; test/compact.test.ts and test/cli check each side).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Check, QuestionAnchor } from './types'

/** A place findAnchor may put the code (0-based lines), with what ranks it. */
type Candidate = { start: number; end: number; fresh: boolean; dLen: number; ctx: number; dist: number }
/** A range a question's lines are in (the question itself, or one of its `also`). */
type Anchored = { file: string; start?: number; end?: number; target?: 'file'; anchor?: QuestionAnchor }

const norm = (s: string): string => s.replace(/\s+/g, '').replace(/['`]/g, '"').replace(/[;,]+$/, '')
const blank = (s: string): boolean => norm(s) === ''
const sha12 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12)
/** The compact anchor of lines [start, end] (1-based, inclusive) of a file's lines. */
export function compactOf(lines: string[], start: number, end: number): QuestionAnchor | undefined {
  const s = start - 1, e = end - 1
  const block = lines.slice(s, e + 1)
  const solid = block.filter((l) => !blank(l))
  if (!solid.length) return undefined
  let b = s - 1
  while (b >= 0 && blank(lines[b])) b--
  let a = e + 1
  while (a < lines.length && blank(lines[a])) a++
  return { v: 3, head: solid.slice(0, 3).join('\n'), tail: solid.slice(-2).join('\n'), lines: block.length, hash: sha12(block.map(norm).filter(Boolean).join('\n')),
    before: b >= 0 ? lines[b] : '', after: a < lines.length ? lines[a] : '' }
}

const weak = (s: string): boolean => norm(s).length < 3
/** Non-blank lines from `i` on match `want` (normalized) in order: the index of the last one, else undefined. */
function forward(lines: string[], i: number, want: string[]): number | undefined {
  let k = i
  for (let w = 0; w < want.length; w++) {
    while (k < lines.length && blank(lines[k])) k++
    if (k >= lines.length || norm(lines[k]) !== want[w]) return undefined
    if (w < want.length - 1) k++
  }
  return k
}
function backward(lines: string[], e: number, want: string[], floor: number): boolean {
  let k = e
  for (let w = want.length - 1; w >= 0; w--) {
    while (k >= floor && blank(lines[k])) k--
    if (k < floor || norm(lines[k]) !== want[w]) return false
    k--
  }
  return true
}
/**
 * Where a compact anchor's code is now (0-based `{ start, end, fresh }`), or undefined when it is gone. `hint`: where
 * it was. The rules of the extension's findCompact (src/core/anchors/compact.ts): head and tail found in order, an exact hash
 * first, then the closest length, then the context lines, then the nearest place. Both sides run the same cases
 * (test/fixtures/compact-cases.json).
 */
export function findAnchor(lines: string[], a: QuestionAnchor, hint = 0): { start: number; end: number; fresh: boolean } | undefined {
  const head = String(a?.head ?? '').split('\n').map(norm).filter(Boolean)
  const tail = String(a?.tail ?? '').split('\n').map(norm).filter(Boolean)
  if (!head.length) return undefined
  if (!tail.length) tail.push(...head.slice(-2))
  const L = Math.max(1, a.lines || 1)
  const minLen = Math.max(1, Math.ceil(L * 0.5)), maxLen = Math.floor(L * 1.5 + 5)
  const before = weak(a.before ?? '') ? '' : norm(a.before), after = weak(a.after ?? '') ? '' : norm(a.after)
  // Either reading of the normalized text: non-blank lines only, or every line (blanks as '').
  const hashOf = (block: string[]) => sha12(block.map(norm).filter(Boolean).join('\n'))
  const hashAllOf = (block: string[]) => sha12(block.map(norm).join('\n'))
  // A candidate's rank, compared in order (lower is better): fresh, closest length, more context, nearest.
  const rank = (c: Candidate): number[] => [c.fresh ? 0 : 1, c.dLen, -c.ctx, c.dist]
  let best: Candidate | undefined
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) !== head[0]) continue
    const headEnd = forward(lines, i, head)
    if (headEnd === undefined) continue
    let b = i - 1
    while (b >= 0 && blank(lines[b])) b--
    const ctxBefore = before && b >= 0 && norm(lines[b]) === before ? 1 : 0
    for (const { end, afterLine: f } of candidateEnds(lines, i, headEnd, tail, L, minLen, maxLen)) {
      const ctxAfter = after && f < lines.length && norm(lines[f]) === after ? 1 : 0
      const block = lines.slice(i, end + 1)
      const c: Candidate = {
        start: i,
        end,
        fresh: !a.hash || hashOf(block) === a.hash || hashAllOf(block) === a.hash,
        dLen: Math.abs(end - i + 1 - L),
        ctx: ctxBefore + ctxAfter,
        dist: Math.abs(i - hint),
      }
      if (!best || lessThan(rank(c), rank(best))) best = c
    }
  }
  return best && { start: best.start, end: best.end, fresh: best.fresh }
}

/**
 * Where the code starting at `start` (head matched up to `headEnd`) may end: lines where the tail matches, with a
 * length in [minLen, maxLen], each with the first non-blank line after it. A range stored with blank lines at its end
 * is tried at its stored length too, so trailing blank lines don't make an unchanged range look moved.
 */
function candidateEnds(lines: string[], start: number, headEnd: number, tail: string[], storedLen: number, minLen: number, maxLen: number): { end: number; afterLine: number }[] {
  const out: { end: number; afterLine: number }[] = []
  const last = Math.min(lines.length - 1, start + maxLen - 1)
  for (let e = Math.max(headEnd, start + minLen - 1); e <= last; e++) {
    if (norm(lines[e]) !== tail[tail.length - 1] || !backward(lines, e, tail, start)) continue
    let afterLine = e + 1
    while (afterLine < lines.length && blank(lines[afterLine])) afterLine++
    out.push({ end: e, afterLine })
    const stored = start + storedLen - 1
    if (stored > e && stored < lines.length && lines.slice(e + 1, stored + 1).every(blank)) out.push({ end: stored, afterLine })
  }
  return out
}

/** `a` comes before `b` (lists of numbers compared element by element). */
function lessThan(a: number[], b: number[]): boolean {
  const k = a.findIndex((x, i) => x !== b[i])
  return k >= 0 && a[k] < b[k]
}

/**
 * Moves each question's lines (and its `also` ranges) to where their anchored code is now in the working tree, so
 * the panel, the file and the merge request comment show today's line numbers. Returns how many ranges moved.
 */
export function relocate(repo: string, check: Check): number {
  const cache = new Map<string, string[] | undefined>()
  const linesOfFile = (f: string) => {
    if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/)) } catch { cache.set(f, undefined) } }
    return cache.get(f)
  }
  let moved = 0
  const move = (r: Anchored | undefined) => {
    if (!r || r.target === 'file' || !r.anchor || !Number.isInteger(r.start)) return
    const lines = linesOfFile(r.file)
    const at = lines && findAnchor(lines, r.anchor, r.start! - 1)
    if (!at || (at.start + 1 === r.start && at.end + 1 === r.end)) return
    r.start = at.start + 1; r.end = at.end + 1; moved++
  }
  for (const q of check.questions ?? []) { move(q); for (const x of q.also ?? []) move(x) }
  return moved
}
