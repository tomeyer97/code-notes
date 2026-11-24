// The shared relocation cases (test/fixtures/compact-cases.json), with their anchors made from the code they were
// written on: each case is `was` (default: `now`) and the 0-based `range` the anchor is taken from, then `now`, the
// file it is looked for in. `hash`: "none" (an anchor without one) or "every-line" (the other reading of the
// normalized text). Run by test/compact.test.ts, test/golden-notes.test.ts and, against the CLI bundle,
// test/cli/units.test.mjs.
import * as fs from 'fs'
import * as path from 'path'
import { blockHashAll, CompactAnchor, compactOf } from '../src/core/anchors/compact'

export interface CompactCase {
  name: string
  anchor: CompactAnchor
  now: string[]
  hint: number
  expected: { state: string; start?: number; end?: number }
}

interface WrittenCase { name: string; was?: string[]; range: [number, number]; hash?: 'none' | 'every-line'; now: string[]; hint: number; expected: CompactCase['expected'] }

const FILE = path.join(__dirname, '../../test/fixtures/compact-cases.json')

export function compactCases(): CompactCase[] {
  const written: WrittenCase[] = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  return written.map((c) => {
    const was = c.was ?? c.now
    const [s, e] = c.range
    const made = compactOf(was, s, e)
    if (!made) throw new Error(`${c.name}: no code at lines ${s}-${e}`)
    const hash = c.hash === 'none' ? '' : c.hash === 'every-line' ? blockHashAll(was.slice(s, e + 1)) : made.hash
    return { name: c.name, anchor: { ...made, hash }, now: c.now, hint: c.hint, expected: c.expected }
  })
}
