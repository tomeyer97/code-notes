// What Claude is told about a note (src/ask/prompts.ts), as golden text: a first question, a follow-up, the hints
// (the check's own: src/check/prompts.ts, added through its AskHandler).
import { test } from 'node:test'
import type { Note } from '../src/notes/store'
import type { NoteData } from '../src/core/format/noteModel'
import { claudePrompt, SKILLS_HINT, stepAskHint } from '../src/ask/prompts'
import { checkAskHint as checkHint } from '../src/check/prompts'
import { UPDATE_ASK } from '../src/tour/texts'
import { expectGolden } from './golden'

/** A note as prompts.ts reads it (only its data). */
const note = (d: Partial<NoteData>): Note => ({
  data: {
    id: 'n1', file: 'src/a.ts', range: { start: 2, end: 3 }, status: 'open',
    anchor: { text: 'old line two\nold line three' }, messages: [], ...d,
  } as NoteData,
} as unknown as Note)

const code = ['line one', 'line two', 'line three', 'line four']
const asked = { author: 'Pat', role: 'human' as const, body: 'Why is this read twice?' }

test('prompts for a note', () => {
  const first = claudePrompt(note({ messages: [asked], selection: { text: 'read', startCol: 0, endCol: 4 } as NoteData['selection'] }), code, 'Pat')
  const stale = claudePrompt(note({ messages: [asked], stale: true }), code, 'Pat')
  const file = claudePrompt(note({ messages: [asked], target: 'file' }), code, 'Pat')
  const followUp = claudePrompt(note({
    claudeSession: 's1',
    messages: [asked, { author: 'Claude', role: 'agent', body: 'Once.' }, { author: 'Reviewer', role: 'agent', body: 'Twice, see b.ts.' }, { author: 'Pat', role: 'human', body: 'Which?' }],
  }), code, 'Pat')
  const step = stepAskHint(note({ messages: [asked], extra: { journey: 'saving' } }))
  const update = stepAskHint(note({ messages: [{ ...asked, body: UPDATE_ASK }], extra: { journey: 'saving' } }))
  const fix = checkHint(note({ messages: [asked], extra: { checkFix: 'q1' } }))
  const fixAnswered = checkHint(note({ messages: [asked, { author: 'Claude', role: 'agent', body: 'Done.' }], extra: { checkFix: 'q1' } }))
  const checkAsk = checkHint(note({ messages: [asked], extra: { checkAsk: 'What does allow() return?' } }))
  const skills = SKILLS_HINT(['code-journey', 'review'], '/opt/agent/.claude/skills')
  const parts = { first, stale, file, followUp, step, update, fix, fixAnswered, checkAsk, skills }
  expectGolden('ask', 'prompts', Object.entries(parts).map(([k, v]) => `===== ${k}\n${v}`).join('\n'))
})
