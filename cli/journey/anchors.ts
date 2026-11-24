// Where a step's or a box's code is now, and where a link's, value's or beat's line is: the extension's own rules
// (src/core/anchors), so `journey.py check` and the extension agree on what moved, changed or is gone.
import fs from 'node:fs'
import path from 'node:path'
import { findCompact, toCompact } from '../../src/core/anchors/compact'
import { readAnchor } from '../../src/core/anchors/kinds'
import { blank } from '../../src/core/anchors/lines'
import { findLine } from '../../src/core/anchors/lineFollow'

/** A repository file's lines as journey.py reads them (bad bytes replaced); undefined when it can't be read. */
export function fileLines(repo: string, file: string): string[] | undefined {
  try { return fs.readFileSync(path.join(repo, file), 'utf8').split('\n') } catch { return undefined }
}

/** Where anchor `a` is in `lines`: [start, end, same hash] (0-based), or null when its head or tail is not there.
 *  `hint`: where it was (0-based). A range of blank lines can't be followed: in place while it is still blank. */
export function place(lines: string[], a: unknown, hint: number): [number, number, boolean] | null {
  const read = readAnchor(a)
  const c = read && toCompact(read)
  if (!c) {
    const w = (a ?? {}) as Record<string, unknown>
    const n = typeof w.lines === 'number' ? w.lines : typeof w.text === 'string' ? w.text.split('\n').length : 1
    const stillBlank = hint >= 0 && hint + n <= lines.length && lines.slice(hint, hint + n).every(blank)
    return stillBlank ? [hint, hint + n - 1, true] : null
  }
  const got = findCompact(lines, c, hint)
  return got.state === 'gone' ? null : [got.loc.start, got.loc.end, got.state === 'fresh']
}

/** The 0-based line that still reads `text` (trimmed) at or near 1-based `line`; -1 when none does. */
export const lineOf = (lines: string[], line: number, text: string) => findLine(lines, line - 1, text ?? '')
