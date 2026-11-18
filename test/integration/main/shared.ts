// The fixtures several main/ test files share: the demo journey (written by journeyTour.ts, used again by
// journeyFiles.ts), the "saving" journey kept in the repository (repoJourneys.ts, requests.ts) and the unread finding
// (written by keysAndMap.ts, resolved by notesReview.ts). Builders for any journey or note: ../fixtures.ts.
import * as fs from 'fs'
import * as path from 'path'
import { compactOf } from '../../../src/compact'
import { StepFixture, journey, step } from '../fixtures'
import { journeysDir, wsPath } from './context'

// ---------- the demo journey (personal: .code-notes/journeys/demo.json) ----------

/** A step of the demo journey: its lead is "<title>: the lead.". */
export const demoStep = (id: string, title: string, node: string, file: string, line: number, extra: object = {}) =>
  step(file, line, line, { id, title, node, lead: `${title}: the lead.`, ...extra })

/** a() calls b() in src/flow.ts, then c in src/flow2.ts. Step 1's details and refs are what the card's tests read. */
export const demoSteps: StepFixture[] = [
  demoStep('s-a', 'a calls b', 'fa', 'src/flow.ts', 2, { details: 'More about **a**: see src/flow.ts:5 (and src/flow.ts:6-7). Charges card <name>.', refs: ['src/flow.ts:5', 'src/gone.ts:3', 'Recipients builds the list of addresses a receipt goes to in lib/mail/address.go:31-54.'] }),
  demoStep('s-b', 'b returns', 'fb', 'src/flow.ts', 6),
  demoStep('s-c', 'Then c', 'fc', 'src/flow2.ts', 2),
]

/** The demo journey: five boxes (App > flow > a, b, c), `steps` (the three demo steps by default). */
export const demoJourney = (steps: StepFixture[] = demoSteps) => journey('demo', steps, {
  question: 'How does a get to c?', title: 'Demo', summary: 'a, b, then c.',
  nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'm', kind: 'module', label: 'flow', summary: '', parent: 'app' },
    { id: 'fa', kind: 'function', label: 'a', summary: '', parent: 'm' }, { id: 'fb', kind: 'function', label: 'b', summary: '', parent: 'm' },
    { id: 'fc', kind: 'function', label: 'c', summary: '', parent: 'm' }],
  edges: [{ from: 'fa', to: 'fb', label: 'calls' }, { from: 'fb', to: 'fc', label: 'later', async: true }],
})
export const demoPath = () => path.join(journeysDir(), 'demo.json')
export const writeDemo = (steps?: StepFixture[]) => fs.writeFileSync(demoPath(), JSON.stringify(demoJourney(steps), null, 2))

// ---------- the "saving" journey (in the repository: <ws>/journeys) ----------

/** src/saving.ts: saveNote on lines 3-8, loadNote on 10-13. */
export const savingTs = ['import { write } from "./disk"', '', 'export function saveNote(n: Note) {', '  const raw = serialize(n)', '  write(n.path, raw)', '  log(n.id)', '  return raw', '}', '',
  'export function loadNote(p: string) {', '  const raw = read(p)', '  return parse(raw)', '}', '']

/** <ws>/journeys */
export const repoJourneysDir = () => wsPath('journeys')

/** "Saving a note": two steps with compact anchors, the first one's box anchored too. */
export const savingJourney = journey('saving', [
  step('src/saving.ts', 3, 8, { id: 'save', title: 'saveNote serializes and writes', node: 'save', anchor: compactOf(savingTs, 2, 7) }),
  step('src/saving.ts', 10, 13, { id: 'load', title: 'loadNote parses', node: 'load', lead: 'There.', anchor: compactOf(savingTs, 9, 12) }),
], {
  question: 'How is a note saved to disk?', title: 'Saving a note', summary: 'A note is serialized and written.',
  nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'save', kind: 'function', label: 'saveNote', parent: 'app', summary: '', at: { file: 'src/saving.ts', start: 3, end: 8, anchor: compactOf(savingTs, 2, 7) } },
    { id: 'load', kind: 'function', label: 'loadNote', parent: 'app', summary: '' }],
})

// ---------- notes ----------

/** An unread agent note on src/flow2.ts:1: written by keysAndMap.ts (D goes to it), resolved by notesReview.ts (R). */
export const UNREAD_FINDING = '20261111-200000-unr1'
