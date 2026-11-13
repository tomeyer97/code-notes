// Keeping a note on the code it was written about, without the vscode API (unit-tested in test/).
//
// A note stores the lines it was written on (anchor text) and a couple of lines around them (context). When the
// file changes:
//   - the anchor text is still at the tracked position                        -> fine
//   - it is elsewhere in the file with matching context (or long and unique)  -> the note moves there
//   - otherwise (code edited, deleted, or only found in an unrelated place)   -> stale, at its last position
// Lines are compared without whitespace and with one quote style, so reformatting does not make a note stale.
// A note on blank lines is anchored on its context alone.

/** 0-based, inclusive line range. */
export interface Loc { start: number; end: number }

export interface AnchorResult { loc: Loc; stale: boolean; moved: boolean }

/** What a line means for comparison: no whitespace, one quote style, no trailing; or,. */
export const norm = (s: string) => s.replace(/\s+/g, '').replace(/['`]/g, '"').replace(/[;,]+$/, '')

const blank = (s: string) => norm(s) === ''
/** Lines like `}` or `);` say nothing about where code is: they don't count as context. */
const weak = (s: string) => norm(s).length < 3

export function matchesAt(lines: string[], anchor: string[], start: number): boolean {
  if (start < 0 || start + anchor.length > lines.length) return false
  for (let i = 0; i < anchor.length; i++) if (norm(lines[start + i]) !== norm(anchor[i])) return false
  return true
}

/** Context lines (non-blank ones only) that match around a block of `len` lines at `start`, and how many could. */
export function contextScore(lines: string[], start: number, len: number, before: string[], after: string[]): { score: number; max: number } {
  let score = 0, max = 0
  for (let i = 0; i < before.length; i++) {
    if (weak(before[i])) continue
    max++
    const at = start - before.length + i
    if (at >= 0 && norm(lines[at]) === norm(before[i])) score++
  }
  for (let i = 0; i < after.length; i++) {
    if (weak(after[i])) continue
    max++
    const at = start + len + i
    if (at < lines.length && norm(lines[at]) === norm(after[i])) score++
  }
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
  const found: { at: number; score: number }[] = []
  for (let i = 0; i + anchor.length <= lines.length; i++) {
    if (norm(lines[i]) !== first || !matchesAt(lines, anchor, i)) continue
    found.push({ at: i, score: contextScore(lines, i, anchor.length, before, after).score })
  }
  const substantial = anchor.filter((l) => !weak(l)).length >= 2 || (anchor.length === 1 && norm(anchor[0]).length >= DISTINCT)
  const ok = found.filter((c) => c.score > 0 || (substantial && found.length === 1))
  ok.sort((a, b) => b.score - a.score || Math.abs(a.at - hint) - Math.abs(b.at - hint))
  return ok[0]?.at
}

/** A note on blank lines: where its context (the code around it) is now. */
function relocateByContext(lines: string[], len: number, before: string[], after: string[], tracked: number): { at: number; exact: boolean } | undefined {
  let best: { at: number; score: number } | undefined
  let max = 0
  for (let i = 0; i + len <= lines.length; i++) {
    let allBlank = true
    for (let k = 0; k < len; k++) if (!blank(lines[i + k])) { allBlank = false; break }
    if (!allBlank) continue
    const c = contextScore(lines, i, len, before, after)
    max = c.max
    if (c.score === 0) continue
    if (!best || c.score > best.score || (c.score === best.score && Math.abs(i - tracked) < Math.abs(best.at - tracked))) best = { at: i, score: c.score }
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

/** Where edited code most likely is now: the offset near `tracked` that keeps most of its (and its context's) lines. */
export function closest(lines: string[], anchor: string[], before: string[], after: string[], tracked: number, window = 40): Loc | undefined {
  const len = anchor.length
  const want = anchor.map((l) => (weak(l) ? '' : norm(l)))
  let best: { at: number; score: number } | undefined
  for (let at = Math.max(0, tracked - window); at <= Math.min(lines.length - 1, tracked + window); at++) {
    // Lines of the block found within a few lines of where they would be (an insertion inside it shifts the rest).
    let score = 0
    for (let i = 0; i < len; i++) {
      if (!want[i]) continue
      for (let d = 0; d <= 3; d++) if ([at + i + d, at + i - d].some((k) => k >= 0 && k < lines.length && norm(lines[k]) === want[i])) { score += 4 - d; break }
    }
    score += contextScore(lines, at, len, before, after).score * 2
    if (score > 0 && (!best || score > best.score || (score === best.score && Math.abs(at - tracked) < Math.abs(best.at - tracked)))) best = { at, score }
  }
  if (!best) return undefined
  // Its end: where the block's last recognisable line is now, if it is close; else its own length.
  let end = best.at + len - 1
  const lastI = want.map((w, i) => (w ? i : -1)).filter((i) => i >= 0).pop()
  if (lastI !== undefined) {
    for (let d = 0; d <= 6; d++) {
      const hit = [best.at + lastI + d, best.at + lastI - d].find((k) => k >= best!.at && k < lines.length && norm(lines[k]) === want[lastI])
      if (hit !== undefined) { end = hit + (len - 1 - lastI); break }
    }
  }
  return { start: best.at, end: clamp(end, best.at, Math.max(best.at, lines.length - 1)) }
}

/** The lines removed and added between two versions of a block (a longest-common-subsequence diff). */
export function lineDiff(a: string[], b: string[]): { del: string[]; ins: string[] } {
  if (a.length * b.length > 250_000) return { del: a, ins: b }
  const n = a.length, m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = norm(a[i]) === norm(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const del: string[] = [], ins: string[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (norm(a[i]) === norm(b[j])) { i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) del.push(a[i++]); else ins.push(b[j++])
  }
  while (i < n) del.push(a[i++])
  while (j < m) ins.push(b[j++])
  return { del, ins }
}

/** One text edit, in line terms: lines [startLine, endLine] replaced by text with `newLines` line breaks. */
export interface LineEdit { startLine: number; startChar: number; endLine: number; endChar: number; newLines: number }

/** Follows an edit made in the editor: lines above shift the note, edits inside it grow or shrink it. */
export function shift(loc: Loc, e: LineEdit): Loc {
  const delta = e.newLines - (e.endLine - e.startLine)
  // Entirely above the note, or an insertion at the very start of its first line (pushes it down).
  if (e.endLine < loc.start || (e.endLine === loc.start && e.endChar === 0 && e.startLine < loc.start) ||
      (e.startLine === loc.start && e.endLine === loc.start && e.startChar === 0 && e.endChar === 0 && e.newLines > 0)) {
    return { start: loc.start + delta, end: loc.end + delta }
  }
  if (e.startLine > loc.end) return loc
  // Overlaps the note.
  const start = Math.min(loc.start, e.startLine)
  return { start, end: Math.max(start, loc.end + delta) }
}

/** An edit that replaces the whole note and more (a file reloaded from disk, a big paste): tracking it is meaningless. */
export function swallows(loc: Loc, e: LineEdit): boolean {
  return e.startLine <= loc.start && e.endLine >= loc.end && e.endLine - e.startLine > loc.end - loc.start
}

/**
 * A stale step: edited in place (most of its lines, or the lines around it, are still there: a diff) or removed (its
 * code is not near its old place any more).
 */
export function staleKind(lines: string[], a: { text: string; before: string; after: string }, loc: { start: number; end: number }): { removed?: boolean; was?: string; now?: string } {
  // Lines like `}` or `return` say nothing about which code this is.
  const want = a.text.split('\n').map(norm).filter((l) => l.length > 3)
  const lo = Math.max(0, loc.start - 3), hi = Math.min(lines.length, loc.end + 4)
  const near = new Set(lines.slice(lo, hi).map(norm))
  const kept = want.filter((l) => near.has(l)).length
  const ctx = [...a.before.split('\n'), ...a.after.split('\n')].map(norm).filter(Boolean)
  const ctxKept = ctx.filter((l) => near.has(l) || lines.slice(Math.max(0, lo - 3), hi + 3).map(norm).includes(l)).length
  const edited = want.length > 0 && (kept / want.length >= 0.4 || (ctx.length > 0 && ctxKept / ctx.length >= 0.75 && kept > 0))
  if (!edited) return { removed: true }
  return { was: a.text, now: lines.slice(loc.start, Math.min(lines.length, loc.end + 1)).join('\n') }
}

