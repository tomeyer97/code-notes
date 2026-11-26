// Where "Open Note File at the Problem" puts the cursor in a note file that is not JSON (src/notes/brokenAt.ts): where
// the parser stopped, not the end of the file. (The fields it points at in a file that is JSON: noteCommands.test.ts.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokenOffset } from '../src/notes/brokenAt'

/** The 1-based line and column of `offset` in `text`, as the editor shows them. */
function lineCol(text: string, offset: number): [number, number] {
  const before = text.slice(0, offset).split('\n')
  return [before.length, before[before.length - 1].length + 1]
}

const note = {
  version: 1, id: 'n1', file: 'src/notes/store.ts', range: { start: 120, end: 121 },
  anchor: { text: 'a', before: 'b', after: 'c', commit: 'abc1234', branch: 'main' }, session: 'Review', status: 'open',
  createdAt: '2026-11-26T09:00:00.000Z',
  messages: [
    { author: 'ann', role: 'human', body: 'Why?', at: '2026-11-26T09:00:00.000Z' },
    { author: 'Claude', role: 'agent', body: 'Because.', at: '2026-11-26T09:01:00.000Z' },
  ],
}

test('brokenOffset: a file that is not JSON puts the cursor where the parser stopped (line 23, column 14), not at the end', () => {
  // As `sed 's/"body"/"body" BROKEN,/'` leaves it.
  const text = JSON.stringify(note, null, 2).replace(/"body"/g, '"body" BROKEN,')
  assert.deepEqual(lineCol(text, brokenOffset(text)), [23, 14])
  assert.ok(brokenOffset(text) < text.length - 100, 'not at the end')
})

test('brokenOffset: where the parser stopped, also when its message names no place; cut off: the end', () => {
  const cases: [string, string][] = [
    ['{\n  "file": "a.ts",,\n}', '2:18'],
    ['{\n  "file" "a.ts"\n}', '2:10'],
    // "Unexpected token 'x'": no position in the message.
    ['{\n  "messages": [\n    { "body": x }\n  ]\n}', '3:15'],
    ['{\n  "status": open\n}', '2:13'],
  ]
  for (const [text, want] of cases) assert.equal(lineCol(text, brokenOffset(text)).join(':'), want, text)
  for (const cut of ['{ "file": "a.ts", "messages": [', '{ "file": "a.t', '{ "file": tr']) assert.equal(brokenOffset(cut), cut.length, cut)
})
