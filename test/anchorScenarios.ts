// The edits of test/fixtures/anchor-scenarios.json: one file, one range, the same named scenarios for both anchor
// engines (test/anchor.test.ts, test/compact.test.ts), each with what each engine makes of it.
import * as fs from 'fs'
import * as path from 'path'

export interface AnchorScenario {
  name: string
  now: string[]
  fullText: { start: number; end: number; stale: boolean }
  compact: { state: string; start?: number; end?: number }
}

const written = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/anchor-scenarios.json'), 'utf8'))

/** The file the anchors are taken from. */
export const WAS: string[] = written.was
/** The anchored lines of WAS, 0-based, inclusive. */
export const RANGE = { start: written.range[0] as number, end: written.range[1] as number }
export const SCENARIOS: AnchorScenario[] = written.scenarios.map((s: AnchorScenario) => ({ ...s, now: s.now ?? WAS }))
