// A note file's content (src/noteModel.ts): reading, writing, the three-way merge, the notes folder setting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NoteData, agentReadme, captureAnchor, folderProblem, merge, parseNote, serialize, titleOf } from '../src/noteModel'

const note = (o: Record<string, unknown> = {}) => JSON.stringify({
  file: 'src/a.ts', range: { start: 3, end: 5 }, status: 'open', messages: [{ author: 'ann', role: 'human', body: 'Why?' }], ...o,
})
const parsed = (o: Record<string, unknown> = {}) => parseNote(note(o), 'n1') as NoteData

test('parseNote: the fields it knows, in the order they are written back', () => {
  const d = parsed({ session: ' Review ', severity: 'high', createdAt: '2026-11-17T10:00:00Z', anchor: { text: 'x', commit: 'abc' } })
  assert.deepEqual(d, {
    id: 'n1', file: 'src/a.ts', range: { start: 3, end: 5 }, anchor: { text: 'x', before: '', after: '', commit: 'abc' },
    session: 'Review', status: 'open', stale: false, createdAt: '2026-11-17T10:00:00Z',
    messages: [{ author: 'ann', role: 'human', body: 'Why?' }], severity: 'high',
  })
  assert.deepEqual(Object.keys(d), ['id', 'file', 'range', 'anchor', 'session', 'status', 'stale', 'createdAt', 'messages', 'severity'])
})

test('parseNote: why a file is not a note', () => {
  assert.match(parseNote('{', 'x') as string, /^not valid JSON/)
  assert.equal(parseNote('[]', 'x'), 'missing "file"')
  assert.equal(parseNote('3', 'x'), 'not a JSON object')
  assert.equal(parseNote(note({ file: '' }), 'x'), 'missing "file"')
  assert.match(parseNote(note({ target: 'line' }), 'x') as string, /^"target" is "line"/)
  assert.match(parseNote(note({ range: { start: 1 } }), 'x') as string, /^"range" needs integer/)
  assert.equal(parseNote(note({ range: { start: 0, end: 1 } }), 'x'), '"range.start" is 0: lines are 1-based')
  assert.equal(parseNote(note({ range: { start: 4, end: 2 } }), 'x'), '"range" ends (2) before it starts (4)')
  assert.match(parseNote(note({ status: 'done' }), 'x') as string, /^"status" is "done"/)
  assert.equal(parseNote(note({ messages: {} }), 'x'), '"messages" must be an array')
  assert.match(parseNote(note({ messages: [] }), 'x') as string, /is empty/)
  assert.equal(parseNote(note({ messages: [{ author: 'a' }] }), 'x'), 'message 1 needs a "body" string')
})

test('parseNote: loose parts are read leniently', () => {
  assert.equal(parsed({ file: '.\\src\\b.ts' }).file, 'src/b.ts')
  assert.deepEqual(parsed({ selection: 'readToken' }).selection, { text: 'readToken', startCol: 0, endCol: 0 }, 'a plain string is the text')
  assert.deepEqual(parsed({ selection: { text: 't', startCol: '4' } }).selection, { text: 't', startCol: 4, endCol: 0 })
  assert.equal(parsed({ session: '  ' }).session, undefined)
  assert.equal(parsed({ claudeSession: '' }).claudeSession, undefined)
  assert.deepEqual(parsed({ messages: [{ body: 'b', role: 'robot', at: 3 }] }).messages, [{ author: 'unknown', body: 'b' }], 'no invented role or time')
  assert.deepEqual(parsed({ events: [{ type: 'resolved', at: 't', role: 'agent' }, { type: 'x', at: 't' }, { type: 'reopened' }] }).events,
    [{ type: 'resolved', by: 'unknown', role: 'agent', at: 't' }])
})

test('parseNote: unknown fields and an unknown severity are kept for writing back', () => {
  const d = parsed({ severity: 'critical', journey: { id: 'j' } })
  assert.equal(d.severity, undefined)
  assert.deepEqual(d.extra, { severity: 'critical', journey: { id: 'j' } })
  assert.equal(serialize(d), JSON.stringify({ ...d, extra: undefined, severity: 'critical', journey: { id: 'j' } }, null, 2) + '\n')
})

test('a file or folder note has no lines: 1-1 in memory, no range, anchor or stale in its file', () => {
  const d = parsed({ target: 'folder', range: undefined, stale: true })
  assert.deepEqual(d.range, { start: 1, end: 1 })
  assert.equal(d.stale, false)
  const back = JSON.parse(serialize(d))
  assert.deepEqual(Object.keys(back), ['id', 'file', 'status', 'messages', 'target'])
})

test('merge: messages and events append; other fields are ours if we changed them, else theirs', () => {
  const base = parsed()
  const ours = { ...structuredClone(base), status: 'resolved' as const, messages: [...base.messages, { author: 'me', body: 'mine' }] }
  const theirs = { ...structuredClone(base), session: 'S', severity: 'low' as const, messages: [...base.messages, { author: 'agent', body: 'theirs' }],
    events: [{ type: 'resolved' as const, by: 'agent', at: 't' }] }
  const m = merge(base, ours, theirs)
  assert.equal(m.status, 'resolved', 'ours: changed here')
  assert.equal(m.session, 'S', 'theirs: not changed here')
  assert.equal(m.severity, 'low')
  assert.deepEqual(m.messages.map((x) => x.body), ['Why?', 'theirs', 'mine'])
  assert.deepEqual(m.events, theirs.events)
  assert.ok(!('target' in m) && !('events' in merge(base, base, base)), 'no empty optional fields')
})

test('merge: a message on both sides is not doubled', () => {
  const base = parsed()
  const reply = { author: 'agent', body: 'same', at: 't' }
  const both = { ...base, messages: [...base.messages, reply] }
  assert.equal(merge(base, both, both).messages.length, 2)
})

test('folderProblem: a sub-folder of the workspace folder, never above it', () => {
  assert.equal(folderProblem('.code-notes'), undefined)
  assert.equal(folderProblem('notes/review/'), undefined)
  for (const v of ['', '.', './']) assert.match(folderProblem(v)!, /sub-folder of its own/)
  for (const v of ['/tmp/x', 'C:\\notes', 'c:/x']) assert.equal(folderProblem(v), 'it must be relative to the workspace folder', v)
  for (const v of ['../x', 'a/../b']) assert.equal(folderProblem(v), 'it must stay inside the workspace folder', v)
})

test('titleOf: the first message of a file that is JSON', () => {
  assert.equal(titleOf(note()), 'Why?')
  assert.equal(titleOf('{'), undefined)
  assert.equal(titleOf('{"messages":[{"body":" "}]}'), undefined)
})

test('captureAnchor: the lines (0-based, inclusive) and two lines of context each side, cut at the file\'s ends', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f']
  assert.deepEqual(captureAnchor(lines, 2, 3), { text: 'c\nd', before: 'a\nb', after: 'e\nf' })
  assert.deepEqual(captureAnchor(lines, 0, 0), { text: 'a', before: '', after: 'b\nc' })
  assert.deepEqual(captureAnchor(lines, 5, 5), { text: 'f', before: 'd\ne', after: '' })
})

test('agentReadme: names the person and the notes folder it is written into', () => {
  const r = agentReadme('Ann', 'review-notes')
  assert.match(r, /^# Code notes\n/)
  assert.match(r, /Notes \*\*Ann\*\* left on the code/)
  assert.match(r, /relative to the folder that contains `review-notes\/`/)
  assert.ok(!r.includes('${'), 'every placeholder filled')
})
