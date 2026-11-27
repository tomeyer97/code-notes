// Compact anchors: a question's lines found again after the code moved. The extension's implementation
// (src/core/anchors/compact.ts), bundled into the CLI: one set of rules for journeys and checks.
import fs from 'node:fs'
import path from 'node:path'
import { compactOf as compactAt, findCompact } from '../../src/core/anchors/compact'
import type { Check, QuestionAnchor } from './types'

/** A range a question's lines are in (the question itself, or one of its `also`). */
type Anchored = { file: string; start?: number; end?: number; target?: 'file'; anchor?: QuestionAnchor }

/** The compact anchor of lines [start, end] (1-based, inclusive) of a file's lines. */
export function compactOf(lines: string[], start: number, end: number): QuestionAnchor | undefined {
  return compactAt(lines, start - 1, end - 1)
}

/** An anchor from a check file, its missing fields filled in (a hand-written file may leave some out). */
function complete(a: Partial<QuestionAnchor> | undefined): QuestionAnchor {
  return {
    v: 3,
    head: String(a?.head ?? ''),
    tail: String(a?.tail ?? ''),
    lines: a?.lines || 1,
    hash: a?.hash ?? '',
    before: a?.before ?? '',
    after: a?.after ?? '',
  }
}

/**
 * Where a compact anchor's code is now (0-based `{ start, end, fresh }`), or undefined when it is gone. `hint`: where
 * it was. The rules are findCompact's (src/core/anchors/compact.ts).
 */
export function findAnchor(lines: string[], a: Partial<QuestionAnchor>, hint = 0): { start: number; end: number; fresh: boolean } | undefined {
  const f = findCompact(lines, complete(a), hint)
  return f.state === 'gone' ? undefined : { start: f.loc.start, end: f.loc.end, fresh: f.state === 'fresh' }
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
