// The notes model's pure parts (src/notes/model/): which notes are listed, the selection, how changes combine, the
// context keys (checked against package.json), where a note is, its lines, who wrote a message, its target.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import type { Note } from '../src/notes/store'
import type { NoteData } from '../src/core/format/noteModel'
import { lastMessage, NoteFacts, NotesQuery, order, sessionOf } from '../src/notes/model/query'
import { NotesSelection } from '../src/notes/model/selection'
import { mergeChanges, onlyThese, whileTyping } from '../src/notes/model/changes'
import { NOTES_CTX, notesContext } from '../src/notes/model/contextKeys'
import { Placement } from '../src/notes/model/placement'
import { clampLines, locOf, range1Of, sameRange, withinLines } from '../src/notes/model/lines'
import { classifyAuthor } from '../src/notes/model/author'
import { fitTarget, isRangelessFileNote } from '../src/notes/model/target'
import { isRow, noteOfRow } from '../src/notes/model/rows'
import { journeyOfNote, stepLinkOf } from '../src/notes/model/journeyLink'
import type { LoadedJourney } from '../src/journeys/steps'

const folder = { uri: { toString: () => 'file:///w' } } as unknown as Note['folder']

function note(id: string, d: Partial<NoteData> = {}): Note {
  const data: NoteData = {
    id, file: 'a.ts', range: { start: 1, end: 1 }, status: 'open',
    anchor: { text: 'x', before: '', after: '' }, messages: [{ author: 'me', role: 'human', body: 'hi' }], ...d,
  } as NoteData
  return { data, folder, uri: { toString: () => `file:///w/.code-notes/${id}.json` } as unknown as Note['uri'] }
}

function facts(list: Note[], o: Partial<NoteFacts> = {}): NoteFacts {
  return { isCheck: () => false, unread: () => 0, revealed: () => undefined, hiddenSessions: () => new Set(), notes: () => list, ...o }
}

test('query: the filter lists open notes, resolved ones when shown or unread, stale ones, unread ones', () => {
  const open = note('o'), done = note('r', { status: 'resolved' }), stale = note('s', { stale: true }), news = note('u', { status: 'resolved' })
  const q = new NotesQuery(facts([open, done, stale, news], { unread: (n) => (n === news ? 1 : 0) }))
  const listed = () => [open, done, stale, news].filter((n) => q.matches(n)).map((n) => n.data.id)
  assert.deepEqual(listed(), ['o', 's', 'u'])
  q.showResolved = true
  assert.deepEqual(listed(), ['o', 'r', 's', 'u'])
  q.filter = 'stale'
  assert.deepEqual(listed(), ['s'])
  q.filter = 'unread'
  assert.deepEqual(listed(), ['u'])
  assert.equal(q.count('all'), 4)
})

test('query: a check question is never listed; the note just opened is listed as unread', () => {
  const a = note('a'), b = note('b')
  const opened: { id?: string } = {}
  const q = new NotesQuery(facts([a, b], { isCheck: (n) => n === b, revealed: () => opened.id }))
  q.filter = 'unread'
  assert.equal(q.matches(a), false)
  opened.id = 'a'
  assert.equal(q.matches(a), true)
  q.filter = 'all'
  assert.equal(q.matches(b), false)
})

test('query: hidden sessions, the note just opened shown anyway; grouping by session only when there are sessions', () => {
  const a = note('a', { session: 'Review' }), b = note('b')
  const opened: { id?: string } = {}
  const q = new NotesQuery(facts([a, b], { hiddenSessions: () => new Set(['Review']), revealed: () => opened.id }))
  assert.equal(q.hiddenInEditor(a), true)
  assert.equal(q.hiddenInEditor(b), false)
  opened.id = 'a'
  assert.equal(q.hiddenInEditor(a), false)
  assert.equal(q.scopeOf(a), undefined)
  q.groupMode = 'session'
  assert.equal(q.scopeOf(a), 'Review')
  assert.equal(q.scopeOf(b), '')
  const none = new NotesQuery(facts([b]))
  none.groupMode = 'session'
  assert.equal(none.scopeOf(b), undefined)
})

test('query: order by line then by time; session and last message', () => {
  const a = note('a', { range: { start: 5, end: 5 } }), b = note('b', { range: { start: 2, end: 2 }, createdAt: '2026-02-01' })
  const c = note('c', { range: { start: 2, end: 2 }, createdAt: '2026-01-01' })
  assert.deepEqual([a, b, c].sort(order).map((n) => n.data.id), ['c', 'b', 'a'])
  assert.equal(sessionOf(a), '')
  assert.equal(lastMessage(a)?.body, 'hi')
  assert.equal(lastMessage(note('e', { messages: [] })), undefined)
})

test('selection: 2 or more rows are ticked; ticks are pruned', () => {
  const s = new NotesSelection()
  s.select(['a'])
  assert.deepEqual([...s.checked], [])
  assert.deepEqual(s.selected, ['a'])
  s.select(['a', 'b', 'c'])
  assert.deepEqual([...s.checked], ['a', 'b', 'c'])
  s.prune((id) => id !== 'b')
  assert.deepEqual([...s.checked], ['a', 'c'])
})

test('changes: per-note kinds name their notes, the others mean every note; a batch is one change', () => {
  assert.deepEqual(onlyThese({ kind: 'saved', ids: ['a'] }), ['a'])
  assert.equal(onlyThese({ kind: 'disk', ids: ['a'] }), undefined)
  assert.equal(onlyThese({ kind: 'seen' }), undefined)
  assert.equal(whileTyping({ kind: 'edited', ids: ['a'] }), true)
  assert.equal(whileTyping({ kind: 'placed', ids: ['a'] }), false)
  assert.deepEqual(mergeChanges([{ kind: 'saved', ids: ['a'] }, { kind: 'placed', ids: ['a', 'b'] }]), { kind: 'placed', ids: ['a', 'b'] })
  assert.deepEqual(mergeChanges([{ kind: 'saved', ids: ['a'] }, { kind: 'removed', ids: ['b'] }]), { kind: 'removed', ids: ['a', 'b'] })
  assert.deepEqual(mergeChanges([{ kind: 'saved', ids: ['a'] }, { kind: 'view', notice: 'x' }]), { kind: 'view', notice: 'x' })
  assert.deepEqual(mergeChanges([{ kind: 'saved', ids: ['a'] }, { kind: 'edited', ids: ['b'] }]), { kind: 'saved', ids: ['a', 'b'] })
  assert.deepEqual(mergeChanges([{ kind: 'edited', ids: ['a'] }, { kind: 'edited', ids: ['b'] }]), { kind: 'edited', ids: ['a', 'b'] })
})

test('context keys: one pass; every key is used in package.json', () => {
  const a = note('a', { session: 'S' }), q = note('q')
  const v = notesContext({
    notes: [a, q], broken: 0, checked: 2, filter: 'stale', groupMode: 'session', showResolved: true,
    isCheck: (n) => n === q, isHidden: (n) => n === a,
  })
  assert.deepEqual(v, { hasNotes: true, listsNotes: true, hasChecked: true, filtered: true, groupBy: 'session', hasSessions: true, hasHiddenSessions: true, showResolved: true })
  const empty = notesContext({ notes: [], broken: 1, checked: 0, filter: 'all', groupMode: 'file', showResolved: false, isCheck: () => false, isHidden: () => false })
  assert.equal(empty.hasNotes, true)
  assert.equal(empty.listsNotes, true)
  assert.equal(empty.hasSessions, false)
  const pkg = fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
  const whens = [...pkg.matchAll(/"(?:when|enablement)":\s*"([^"]*)"/g)].map((m) => m[1]).join('\n')
  const unused = Object.values(NOTES_CTX).filter((k) => !new RegExp(`\\b${k.replace('.', '\\.')}\\b`).test(whens))
  assert.deepEqual(unused, [])
})

test('placement: missing and past the end are one state at a time', () => {
  const p = new Placement()
  p.setPastEnd('a', 10)
  assert.equal(p.pastEnd('a'), 10)
  p.setMissing('a')
  assert.equal(p.missing('a'), true)
  assert.equal(p.pastEnd('a'), undefined)
  p.setPastEnd('a', 3)
  p.found('a', true)
  assert.equal(p.pastEnd('a'), 3)
  p.found('a')
  assert.equal(p.pastEnd('a'), undefined)
  assert.equal(p.missing('a'), false)
})

test('lines: 1-based ranges and 0-based locs, clamped to a document', () => {
  assert.deepEqual(locOf({ start: 3, end: 5 }), { start: 2, end: 4 })
  assert.deepEqual(range1Of({ start: 2, end: 4 }), { start: 3, end: 5 })
  assert.deepEqual(clampLines({ lineCount: 3 }, 7, 9), { start: 2, end: 2 })
  assert.deepEqual(clampLines({ lineCount: 10 }, 0, 2), { start: 0, end: 1 })
  assert.deepEqual(withinLines({ start: 5, end: 9 }, 4), { start: 3, end: 3 })
  assert.equal(sameRange({ start: 1, end: 2 }, { start: 1, end: 2 }), true)
})

test('author: the role decides who is an agent; names decide who is the person, and only for legacy files the rest', () => {
  const me = { current: 'Ada', past: ['ada-old', 'ubuntu'] }
  assert.deepEqual(classifyAuthor({ author: 'Ada', role: 'human' }, me), { mine: true, agent: false })
  assert.deepEqual(classifyAuthor({ author: 'Bob', role: 'human' }, me), { mine: false, agent: false })
  assert.deepEqual(classifyAuthor({ author: 'Claude', role: 'agent' }, me), { mine: false, agent: true })
  assert.deepEqual(classifyAuthor({ author: 'Claude' }, me), { mine: false, agent: true })
  for (const legacy of ['me', 'You', 'ada-old', 'ubuntu']) assert.deepEqual(classifyAuthor({ author: legacy }, me), { mine: true, agent: false })
})

test('target: the folder shorthand, and a note fitted to a folder or a file', () => {
  assert.equal(isRangelessFileNote({ file: 'src/api' }), true)
  assert.equal(isRangelessFileNote({ file: 'src/api', range: { start: 1, end: 1 } }), false)
  assert.equal(isRangelessFileNote({ file: 'src/api', target: 'file' }), false)
  const d = note('a', { selection: { text: 'x' } } as Partial<NoteData>).data
  const f = fitTarget(d, true)
  assert.notEqual(f, d)
  assert.equal(f.target, 'folder')
  assert.deepEqual(f.range, { start: 1, end: 1 })
  assert.equal('selection' in f, false)
  assert.equal(d.target, undefined, 'the note read is not changed')
  assert.equal(fitTarget(d, false), d)
  assert.equal(fitTarget({ ...d, target: 'folder' }, false).target, 'file')
})

test('rows and step links: what a command is given, which step a note was asked from', () => {
  const n = note('a', { extra: { journey: { id: 'j1', n: 2 } } })
  assert.equal(noteOfRow({ kind: 'note', note: n }), n)
  assert.equal(noteOfRow({ kind: 'file', notes: [n] }), undefined)
  assert.equal(isRow({ kind: 'session', name: 'S' }, 'session'), true)
  assert.equal(isRow('a', 'session'), false)
  assert.deepEqual(stepLinkOf(n), { id: 'j1', n: 2 })
  assert.equal(stepLinkOf(note('b', { extra: { journey: { id: 'j1' } } })), undefined)
  const lj = { j: { id: 'j1' }, folder } as unknown as LoadedJourney
  const other = { j: { id: 'j1' }, folder: { uri: { toString: () => 'file:///x' } } } as unknown as LoadedJourney
  assert.equal(journeyOfNote(n, [other, lj]), lj)
  assert.equal(journeyOfNote(note('c'), [lj]), undefined)
})
