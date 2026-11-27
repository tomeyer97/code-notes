// A note file's content (src/core/format/noteModel.ts): reading, writing, the three-way merge, the notes folder setting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { NoteData, captureAnchor, fillReadme, folderProblem, merge, parseNote, serialize, titleOf } from '../src/core/format/noteModel'

const note = (o: Record<string, unknown> = {}) => JSON.stringify({
  file: 'src/a.ts', range: { start: 3, end: 5 }, status: 'open', messages: [{ author: 'ann', role: 'human', body: 'Why?' }], ...o,
})
/** The note `raw` holds (the test fails when parseNote refuses it). */
function noteOf(raw: string, id = 'n1'): NoteData {
  const r = parseNote(raw, id)
  assert.ok(r.ok, r.ok ? '' : r.why)
  return r.value
}
/** Why parseNote refuses `raw` (the test fails when it reads it). */
function refusal(raw: string): string {
  const r = parseNote(raw, 'x')
  assert.equal(r.ok, false, 'refused')
  return r.ok ? '' : r.why
}
const parsed = (o: Record<string, unknown> = {}) => noteOf(note(o))

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
  assert.match(refusal('{'), /^not valid JSON/)
  assert.equal(refusal('[]'), 'missing "file"')
  assert.equal(refusal('3'), 'not a JSON object')
  assert.equal(refusal(note({ file: '' })), 'missing "file"')
  assert.match(refusal(note({ target: 'line' })), /^"target" is "line"/)
  assert.match(refusal(note({ range: { start: 1 } })), /^"range" needs integer/)
  assert.equal(refusal(note({ range: { start: 0, end: 1 } })), '"range.start" is 0: lines are 1-based')
  assert.equal(refusal(note({ range: { start: 4, end: 2 } })), '"range" ends (2) before it starts (4)')
  assert.match(refusal(note({ status: 'done' })), /^"status" is "done"/)
  assert.equal(refusal(note({ messages: {} })), '"messages" must be an array')
  assert.match(refusal(note({ messages: [] })), /is empty/)
  assert.equal(refusal(note({ messages: [{ author: 'a' }] })), 'message 1 needs a "body" string')
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
  assert.equal(serialize(d), JSON.stringify({ version: 1, ...d, extra: undefined, severity: 'critical', journey: { id: 'j' } }, null, 2) + '\n')
})

test('versions: a file without "version" is version 1; the extension writes "version": 1 first; another version is refused', () => {
  assert.deepEqual(parsed({ version: 1 }), parsed(), 'the version is the file\'s, not the note\'s')
  assert.equal(parsed({ version: 1 }).extra, undefined)
  assert.deepEqual(Object.keys(JSON.parse(serialize(parsed())))[0], 'version')
  assert.equal(JSON.parse(serialize(parsed())).version, 1)
  assert.equal(refusal(note({ version: 2 })), '"version" is 2: this extension reads note files of version 1')
  assert.match(refusal(note({ version: '1' })), /^"version" is "1"/)
})

test('a file or folder note has no lines: 1-1 in memory, no range, anchor or stale in its file', () => {
  const d = parsed({ target: 'folder', range: undefined, stale: true })
  assert.deepEqual(d.range, { start: 1, end: 1 })
  assert.equal(d.stale, false)
  const back = JSON.parse(serialize(d))
  assert.deepEqual(Object.keys(back), ['version', 'id', 'file', 'status', 'messages', 'target'])
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

test('parseNote and serialize: fields this version doesn\'t know inside messages, events, range and anchor, and events of other types, are written back', () => {
  const file = {
    file: 'src/a.ts', range: { start: 3, end: 5, rangeExtra: 'r' }, anchor: { text: 'x', anchorExtra: 'a' }, status: 'open',
    messages: [{ author: 'ann', role: 'human', body: 'Why?', msgExtra: 'keep-me', attachments: ['a.png'] }],
    events: [{ type: 'assigned', by: 'bot', at: 't0' }, { type: 'resolved', by: 'ann', at: 't1', why: 'fixed' }, 'odd'],
  }
  const d = noteOf(JSON.stringify(file))
  assert.deepEqual(d.messages[0].extra, { msgExtra: 'keep-me', attachments: ['a.png'] })
  assert.deepEqual(d.events, [{ type: 'resolved', by: 'ann', at: 't1', extra: { why: 'fixed' } }], 'the events this version reads')
  assert.deepEqual(d.otherEvents, [{ index: 0, event: file.events[0] }, { index: 2, event: 'odd' }])
  // Resolved, replied to and moved: nothing of theirs is lost.
  d.status = 'resolved'
  d.events!.push({ type: 'resolved', by: 'me', at: 't2' })
  d.messages.push({ author: 'me', body: 'Done.' })
  d.range = { start: 7, end: 9 }
  d.anchor = { text: 'y', before: '', after: '' }
  const back = JSON.parse(serialize(d))
  assert.deepEqual(back.messages[0], file.messages[0])
  assert.deepEqual(back.range, { start: 7, end: 9, rangeExtra: 'r' })
  assert.deepEqual(back.anchor, { text: 'y', before: '', after: '', anchorExtra: 'a' })
  assert.deepEqual(back.events, [...file.events, { type: 'resolved', by: 'me', at: 't2' }])
  assert.ok(!('otherEvents' in back) && !('rangeExtra' in back) && !('extra' in back.messages[0]), 'nothing of memory\'s own in the file')
  assert.equal(serialize(noteOf(serialize(d))), serialize(d), 'read and written again: the same')
  // A file or folder note has no range or anchor: none of theirs either.
  assert.deepEqual(Object.keys(JSON.parse(serialize(noteOf(JSON.stringify({ ...file, target: 'file' }))))).filter((k) => k === 'range' || k === 'anchor'), [])
})

test('merge: fields this version doesn\'t know, nested ones too, are kept from both sides', () => {
  const base = parsed()
  const ours = { ...structuredClone(base), status: 'resolved' as const, messages: [...base.messages, { author: 'me', body: 'mine', extra: { ours: 1 } }] }
  const theirs = {
    ...structuredClone(base), messages: [{ ...base.messages[0], extra: { attachments: ['a.png'] } }, { author: 'agent', body: 'theirs', extra: { tool: 'Read' } }],
    rangeExtra: { r: 1 }, anchorExtra: { a: 1 }, otherEvents: [{ index: 0, event: { type: 'assigned', at: 't0' } }], extra: { custom: true },
  }
  const m = merge(base, ours, theirs)
  assert.equal(m.status, 'resolved')
  assert.deepEqual(m.messages.map((x) => x.extra), [{ attachments: ['a.png'] }, { tool: 'Read' }, { ours: 1 }])
  assert.deepEqual([m.rangeExtra, m.anchorExtra, m.otherEvents, m.extra], [theirs.rangeExtra, theirs.anchorExtra, theirs.otherEvents, theirs.extra])
  const gone = merge(theirs, theirs, { ...structuredClone(base), status: 'open' })
  assert.ok(!('rangeExtra' in gone) && !('otherEvents' in gone), 'removed on disk: removed (no empty fields)')
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

test('captureAnchor (a note\'s, full text; journeys/steps.ts has a compact one): the lines (0-based, inclusive) and two lines of context each side, cut at the file\'s ends', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f']
  assert.deepEqual(captureAnchor(lines, 2, 3), { text: 'c\nd', before: 'a\nb', after: 'e\nf' })
  assert.deepEqual(captureAnchor(lines, 0, 0), { text: 'a', before: '', after: 'b\nc' })
  assert.deepEqual(captureAnchor(lines, 5, 5), { text: 'f', before: 'd\ne', after: '' })
})

test('fillReadme: the README template names the person and the notes folder it is written into', () => {
  const r = fillReadme(fs.readFileSync(path.join(__dirname, '../../media/notes-README.template.md'), 'utf8'), 'Ann', 'review-notes')
  assert.match(r, /^# Code notes\n/, 'the template\'s own comment is left out')
  assert.match(r, /Notes \*\*Ann\*\* left on the code/)
  assert.match(r, /relative to the folder that contains `review-notes\/`/)
  assert.ok(!r.includes('${'), 'every placeholder filled')
})
