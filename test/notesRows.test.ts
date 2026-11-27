// The Code Notes view's pure parts (src/sidebar/): the rows kept per key and forgotten, the structure made once per
// drawing (groups, parents, order, counts), the rows' texts, and the contextValue words package.json's menus match.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import type { Note } from '../src/notes/store'
import type { NoteData } from '../src/core/format/noteModel'
import { NodeCache } from '../src/sidebar/nodeCache'
import { BrokenNode, keyOf, NoteNode, noteNode } from '../src/sidebar/noteNodes'
import { LayoutInput, NotesLayout, rowOrder } from '../src/sidebar/noteGroups'
import { NOTE_FLAGS, rowContext, ROW_WORDS } from '../src/sidebar/rowContext'
import { groupCounts, resolvedLabel, shortDir, unreadMessages, whereLabel } from '../src/sidebar/rowText'

const folder = { uri: { toString: () => 'file:///w' } } as unknown as Note['folder']

function note(id: string, d: Partial<NoteData> = {}): Note {
  const data = {
    id, file: 'src/a.ts', range: { start: 1, end: 1 }, status: 'open',
    anchor: { text: 'x', before: '', after: '' }, messages: [{ author: 'me', role: 'human', body: id }], ...d,
  } as NoteData
  return { data, folder, uri: { toString: () => `file:///w/.code-notes/${id}.json` } as unknown as Note['uri'] }
}

function layout(listed: Note[], o: Partial<LayoutInput> = {}): NotesLayout {
  return new NotesLayout({ listed, visible: listed, broken: [], scopeOf: () => undefined, unread: () => 0, ...o })
}

/** A row as a test reads it: its kind and name, and its children. */
type Shape = string | [string, Shape[]]
function shape(l: NotesLayout, rows: NoteNode[] = l.roots): Shape[] {
  return rows.map((r) => {
    const kids = l.children(r)
    const name = r.kind === 'note' ? `note:${r.note.data.id}` : keyOf(r)
    return kids.length ? [name, shape(l, kids)] : name
  })
}

test('node cache: one object per key, its fields replaced; rows not asked for during a drawing are forgotten', () => {
  const cache = new NodeCache<{ kind: string; a?: number; b?: number }>()
  const first = cache.get('k', { kind: 'x', a: 1 })
  const again = cache.get('k', { kind: 'x', b: 2 })
  assert.equal(again, first, 'the same object: TreeView.reveal finds rows by identity')
  assert.deepEqual({ ...again }, { kind: 'x', b: 2 }, 'the old fields are gone')
  cache.get('gone', { kind: 'y' })
  cache.sweep()
  assert.equal(cache.size, 2, 'both were asked for since the last drawing')
  cache.get('k', { kind: 'x' })
  cache.sweep()
  assert.equal(cache.size, 1, 'a row not made again in a whole drawing is dropped')
  assert.notEqual(cache.get('gone', { kind: 'y' }), undefined)
})

test('layout: every file is a file row, one note or several, by path; notes in the sidebar\'s order', () => {
  const solo = note('solo', { file: 'src/b.ts' })
  const low = note('low', { severity: 'low', range: { start: 2, end: 2 } })
  const high = note('high', { severity: 'high', range: { start: 9, end: 9 } })
  const whole = note('whole', { target: 'file' })
  const first = note('first', { file: 'docs/z.md' })
  const l = layout([solo, low, high, whole, first])
  assert.deepEqual(shape(l), [
    ['file:|file:///w|docs/z.md', ['note:first']],
    ['file:|file:///w|src/a.ts', ['note:high', 'note:whole', 'note:low']],
    ['file:|file:///w|src/b.ts', ['note:solo']],
  ])
  const fileRow = l.roots[1]
  assert.equal(l.parent(noteNode(low)), fileRow, 'the parent recorded while the rows were made')
  assert.equal(l.parent(fileRow), undefined)
  assert.equal(l.parent(noteNode(solo)), l.roots[2], 'a one-note file is a group of one')
  assert.ok(!l.alone(solo) && !l.alone(low), 'under a file row: the row says its lines')
  assert.deepEqual([low, high, whole].sort(rowOrder).map((n) => n.data.id), ['high', 'whole', 'low'])
})

test('layout: by session, sessions with unread notes first then the newest, each a flat list, most severe first', () => {
  const a1 = note('a1', { session: 'A', createdAt: '2026-01-01', severity: 'low' })
  const a2 = note('a2', { session: 'A', createdAt: '2026-01-02', status: 'resolved', file: 'src/b.ts', severity: 'high' })
  const a3 = note('a3', { session: 'A', createdAt: '2026-01-02', file: 'src/a.ts', range: { start: 7, end: 7 }, severity: 'high' })
  const b1 = note('b1', { session: 'B', createdAt: '2026-01-03' })
  const loose = note('loose', { file: 'src/c.ts' })
  const filteredOut = note('a4', { session: 'A', status: 'resolved', file: 'src/z.ts' })
  const broken: BrokenNode = { kind: 'broken', uri: 'file:///w/.code-notes/x.json', why: 'bad JSON' }
  const l = layout([a1, a2, a3, b1, loose], {
    visible: [a1, a2, a3, b1, loose, filteredOut], broken: [broken],
    scopeOf: (n) => n.data.session,
    unread: (n) => (n === a1 ? 2 : 0),
  })
  assert.deepEqual(shape(l), [
    'broken:file:///w/.code-notes/x.json',
    ['session:A', ['note:a3', 'note:a2', 'note:a1']],
    ['session:B', ['note:b1']],
    ['file:|file:///w|src/c.ts', ['note:loose']],
  ])
  assert.deepEqual(l.session('A'), { unread: 1, resolved: 2, total: 4 }, 'resolved out of all of the session\'s notes')
  assert.ok(l.alone(a1) && l.alone(b1), 'in a session the row names its file')
  const session = l.roots[1]
  assert.equal(l.parent(noteNode(b1)), l.roots[2])
  assert.equal(l.parent(noteNode(a2)), session)
})

test('layout: two sessions of 9 findings on the same files: 2 + 18 rows, each session most severe first', () => {
  const sevs = ['low', 'high', 'nit', 'medium', 'high', 'low', 'medium', 'nit', 'high'] as const
  const files = ['src/store.ts', 'src/run.ts', 'src/text.ts']
  const review = (s: string) => sevs.map((severity, i) => note(`${s}${i}`, { session: s, severity, file: files[i % 3], range: { start: i + 1, end: i + 1 } }))
  const notes = [...review('P'), ...review('Q')]
  const l = layout(notes, { scopeOf: (n) => n.data.session })
  const rows = l.roots.flatMap((r) => [r, ...l.children(r)])
  assert.equal(rows.length, 20)
  assert.deepEqual(l.roots.map((r) => r.kind), ['session', 'session'])
  for (const s of l.roots) {
    const kids = l.children(s).map((r) => (r.kind === 'note' ? r.note.data.severity : r.kind))
    assert.deepEqual(kids, ['high', 'high', 'high', 'medium', 'medium', 'low', 'low', 'nit', 'nit'])
    assert.ok(l.children(s).every((r) => r.kind === 'note' && l.alone(r.note)))
  }
})

test('layout: a file row counts its notes with something unread and its stale ones', () => {
  const a = note('a'), b = note('b', { range: { start: 4, end: 4 }, stale: true })
  const l = layout([a, b], { unread: (n) => (n === a ? 3 : 0) })
  assert.deepEqual(l.file('|file:///w|src/a.ts'), { stale: 1, unread: 1 })
})

test('layout: a note not listed (a step\'s question) has no file row above it: its row names its file', () => {
  const q = note('q')
  assert.ok(layout([note('x')]).alone(q))
  assert.ok(layout([note('x'), note('y')]).alone(q))
})

test('row counts: a group says what it counts; "new" is unread messages; a resolve by someone else says who', () => {
  const me = (m: { author: string }) => m.author === 'me'
  assert.deepEqual(groupCounts(2, 1), ['2 notes', '1 new'])
  assert.deepEqual(groupCounts(1, 0), ['1 note', ''])
  // An agent's one-message note, resolved by the agent: one new (the message), not two (message + resolve).
  const perf = note('perf', {
    status: 'resolved', messages: [{ author: 'review-bot', role: 'agent', body: 'Perf finding 8' }],
    events: [{ type: 'resolved', by: 'review-bot', role: 'agent', at: '2026-01-01T00:00:00Z' }],
  })
  assert.equal(unreadMessages(perf, 0, me), 1)
  assert.equal(unreadMessages(perf, 1, me), 0)
  assert.equal(resolvedLabel(perf, (e) => e.by === 'me'), 'resolved by review-bot')
  assert.equal(resolvedLabel(perf, (e) => e.by === 'review-bot'), 'resolved')
  assert.equal(resolvedLabel(note('r', { status: 'resolved' }), () => false), 'resolved', 'no history: just resolved')
  const mine = note('m', { messages: [{ author: 'me', role: 'human', body: 'q' }, { author: 'bot', role: 'agent', body: 'a' }] })
  assert.equal(unreadMessages(mine, 0, me), 1, 'your own message is never new')
})

test('where a note row says it is: lines under a file row, else the file, the whole file or the folder', () => {
  assert.equal(whereLabel(note('a', { range: { start: 3, end: 5 } }), false), 'L3–5')
  assert.equal(whereLabel(note('a', { range: { start: 12, end: 12 } }), true), 'a.ts:12')
  assert.equal(whereLabel(note('a', { target: 'file' }), true), 'a.ts')
  assert.equal(whereLabel(note('a', { file: 'src', target: 'folder' }), true), 'src/')
  assert.deepEqual(['a.ts', 'src/a.ts', 'src/api/v2/a.ts'].map(shortDir), ['', 'src', '…/api/v2'])
})

test('contextValue: the same strings the menus matched before', () => {
  assert.equal(rowContext({ kind: 'note', status: 'open', flags: { stale: true, unread: true, replied: false, asking: true } }), 'note;open;stale;unread;asking')
  assert.equal(rowContext({ kind: 'note', status: 'resolved', flags: {} }), 'note;resolved')
  assert.equal(rowContext({ kind: 'session', hidden: true, named: true }), 'session;hidden;named')
  assert.equal(rowContext({ kind: 'session', hidden: false, named: false }), 'session;shown')
  assert.equal(rowContext({ kind: 'broken', known: true }), 'broken;known')
  assert.equal(rowContext({ kind: 'file' }), 'file')
})

test('contextValue: every word the Code Notes view\'s menus look for is one a row can have', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
  const whens = Object.values(pkg.contributes.menus as Record<string, { when?: string }[]>).flat()
    .map((m) => m.when ?? '').filter((w) => /\bview == codeNotes\.notes\b/.test(w))
  const looked = new Set<string>()
  for (const w of whens) {
    for (const m of w.matchAll(/(!?\(?)viewItem\s*=~\s*\/((?:[^/\\]|\\.)*)\//g)) {
      // `check` is only ever ruled out (no Code Notes row is a check's question).
      if (m[1].startsWith('!')) continue
      for (const word of m[2].split(/[^A-Za-z]+/).filter(Boolean)) looked.add(word)
    }
  }
  const made = new Set<string>()
  for (const status of ['open', 'resolved'] as const) {
    for (const f of NOTE_FLAGS) for (const w of rowContext({ kind: 'note', status, flags: { [f]: true } }).split(';')) made.add(w)
  }
  for (const hidden of [true, false]) for (const w of rowContext({ kind: 'session', hidden, named: true }).split(';')) made.add(w)
  for (const w of rowContext({ kind: 'broken', known: true }).split(';')) made.add(w)
  made.add(rowContext({ kind: 'file' }))
  assert.deepEqual([...looked].filter((w) => !made.has(w)), [], 'a menu looks for a word no row has')
  assert.deepEqual([...made].sort(), [...ROW_WORDS].sort(), 'ROW_WORDS lists what rows are made of')
})
