// Golden tests (test/README.md): a note file as read and written today, byte for byte (the JSON the extension writes
// is the format agents read), the three-way merge, and how anchors find a note's or a step's code again (full v2
// anchors, compact v3 anchors, the stale diff).
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { expectGolden } from './golden'
import { agentReadme, captureAnchor, folderProblem, merge, NoteData, parseNote, serialize, titleOf } from '../src/noteModel'
import { blockHash, compactOf, CompactAnchor, findCompact, toCompact } from '../src/compact'
import { anchor, closest, relocate } from '../src/anchor'
import { lineDiff, staleKind } from '../src/staleDiff'

const AREA = 'notes'
const root = path.join(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

// ---------- note files ----------

const LEGACY = 'test/fixtures/journey/legacy/v1-step-notes'
const legacyNotes = fs.readdirSync(path.join(root, LEGACY)).filter((f) => f.endsWith('.json')).sort()

test('golden: real note files: read, and written back (the bytes the extension writes)', () => {
  for (const f of legacyNotes) {
    const id = f.replace(/\.json$/, '')
    const d = parseNote(read(`${LEGACY}/${f}`), id)
    expectGolden(AREA, `note.${id}`, { parsed: d, title: titleOf(read(`${LEGACY}/${f}`)) ?? null })
    if (typeof d !== 'string') expectGolden(AREA, `note.${id}.written`, serialize(d))
  }
})

const msg = (o: object = {}) => ({ author: 'ann', role: 'human', body: 'Why is this retried?', at: '2026-11-17T10:00:00Z', ...o })
const note = (o: Record<string, unknown> = {}) => ({ file: 'api/orders.js', range: { start: 3, end: 5 }, status: 'open', messages: [msg()], ...o })

/** Notes as agents and older or newer versions write them: each read, then written back. */
const NOTES: [string, unknown][] = [
  ['minimal', note()],
  ['everything known', note({
    id: 'ignored-id', anchor: { text: 'a', before: 'b', after: 'c', commit: 'abc1234', branch: 'feat/x' }, selection: { text: 'total', startCol: 8, endCol: 13 },
    session: '  Review · api  ', status: 'resolved', stale: true, claudeSession: 'sess-1', createdAt: '2026-11-17T09:00:00Z', severity: 'medium',
    messages: [msg(), msg({ author: 'Claude', role: 'agent', body: 'Because the queue is at-least-once.', at: '2026-11-17T10:05:00Z' })],
    events: [{ type: 'resolved', by: 'ann', role: 'human', at: '2026-11-17T11:00:00Z' }, { type: 'deleted', by: 'x', at: 'y' }, { type: 'reopened', at: 3 }],
  })],
  ['unknown fields kept, in place', { future: { a: 1 }, ...note(), zeta: [1, 2], severity: 'critical' }],
  ['a whole file', note({ target: 'file', range: { start: 9, end: 9 }, anchor: { text: 'x' }, stale: true, selection: 'sel' })],
  ['a folder', note({ target: 'folder', file: './api\\sub', range: undefined })],
  ['loose values', note({ file: '.\\api\\orders.js', range: { start: -2, end: -5 }, messages: [{ body: 'no author' }, { author: 7, role: 'bot', body: 'x', at: 5 }], session: '   ', claudeSession: '', createdAt: 5, selection: '  ', anchor: { text: 5, commit: 7 } })],
  ['selection as a string', note({ selection: 'retry()' })],
  ['range end before start after the clamp', note({ range: { start: 0, end: 0 } })],
]
const BAD_NOTES: [string, string][] = [
  ['not json', '{"file":'], ['number', '3'], ['array', '[]'], ['no file', JSON.stringify(note({ file: '' }))],
  ['bad target', JSON.stringify(note({ target: 'line' }))], ['no range', JSON.stringify(note({ range: undefined }))],
  ['range not integers', JSON.stringify(note({ range: { start: 1.5, end: 2 } }))], ['range from 0', JSON.stringify(note({ range: { start: 0, end: 1 } }))],
  ['range backwards', JSON.stringify(note({ range: { start: 4, end: 2 } }))], ['bad status', JSON.stringify(note({ status: 'done' }))],
  ['messages not a list', JSON.stringify(note({ messages: {} }))], ['no messages', JSON.stringify(note({ messages: [] }))],
  ['message without body', JSON.stringify(note({ messages: [msg(), { author: 'x' }] }))],
]

test('golden: crafted notes read and written back; files that are not notes, and why', () => {
  const out = NOTES.map(([name, v]) => {
    const d = parseNote(JSON.stringify(v), 'n1')
    return { name, parsed: d, written: typeof d === 'string' ? null : serialize(d) }
  })
  expectGolden(AREA, 'notes.crafted', out)
  expectGolden(AREA, 'notes.invalid', BAD_NOTES.map(([name, raw]) => ({ name, why: parseNote(raw, 'x'), title: titleOf(raw) ?? null })))
})

test('golden: the three-way merge of a note changed on disk and in memory', () => {
  const base = parseNote(JSON.stringify(note({ events: [{ type: 'resolved', by: 'ann', at: 't1' }] })), 'n') as NoteData
  const with_ = (o: Partial<NoteData>): NoteData => ({ ...base, ...o })
  const m2 = { author: 'Claude', role: 'agent' as const, body: 'An answer.', at: 't2' }
  const m3 = { author: 'ann', role: 'human' as const, body: 'Thanks.', at: 't3' }
  const cases: [string, NoteData, NoteData][] = [
    ['nothing changed', base, base],
    ['they answered, we resolved', with_({ status: 'resolved', events: [...base.events!, { type: 'reopened', by: 'ann', at: 't4' }] }), with_({ messages: [...base.messages, m2] })],
    ['both added messages', with_({ messages: [...base.messages, m3] }), with_({ messages: [...base.messages, m2] })],
    ['both changed the range: ours wins', with_({ range: { start: 9, end: 9 } }), with_({ range: { start: 7, end: 8 } })],
    ['they set severity and a new field', base, with_({ severity: 'low', extra: { x: 1 } })],
    ['we cleared the severity they set', with_({ severity: undefined }), with_({ severity: 'high', target: undefined })],
    ['they removed the events', base, with_({ events: undefined })],
    ['they changed the id and createdAt (theirs kept)', with_({ id: 'ours', createdAt: 'a' }), with_({ id: 'theirs', createdAt: 'b' })],
  ]
  expectGolden(AREA, 'merge', cases.map(([name, ours, theirs]) => { const m = merge(base, ours, theirs); return { name, merged: m, written: serialize(m) } }))
})

test('golden: anchors captured, folder settings, the agents\' README', () => {
  const code = read('examples/shop/api/orders.js').split('\n')
  expectGolden(AREA, 'capture', {
    anchors: [[0, 0], [0, 2], [5, 9], [code.length - 2, code.length - 1], [code.length + 3, code.length + 5]].map(([s, e]) => ({ s, e, anchor: captureAnchor(code, s, e) })),
    folders: ['.code-notes', '', '.', './', ' ./notes/ ', '/abs', 'C:\\x', '..', 'a/../b', 'a\\..\\b', 'notes/sub'].map((f) => [f, folderProblem(f) ?? null]),
  })
  expectGolden(AREA, 'agent-readme', agentReadme('Ann Example', '.code-notes'))
})

// ---------- finding code again: v2 anchors, v3 compact anchors, the stale diff ----------

const shopFiles = ['api/orders.js', 'api/store.js', 'worker/charge.js', 'web/src/checkout/placeOrder.ts']

/** Edits of a file: lines added above, the block's own lines edited, the block removed, reindented, duplicated. */
function edits(lines: string[], s: number, e: number): Record<string, string[]> {
  return {
    same: lines,
    above: ['// added 1', '// added 2', ...lines],
    inside: lines.map((l, i) => (i === s + 1 ? `${l} // changed` : l)),
    removed: [...lines.slice(0, s), ...lines.slice(e + 1)],
    reindented: lines.map((l, i) => (i >= s && i <= e ? `  ${l}` : l)),
    duplicated: [...lines.slice(0, e + 1), '', ...lines.slice(s, e + 1), ...lines.slice(e + 1)],
    truncated: lines.slice(0, s + 1),
  }
}

test('golden: note anchors (v2) found again after edits, and what a stale one says changed', () => {
  const out = shopFiles.map((f) => {
    const lines = read(`examples/shop/${f}`).split('\n')
    const spans = [[2, 4], [Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 3], [lines.length - 4, lines.length - 2]]
    return {
      file: f,
      spans: spans.map(([s, e]) => {
        const a = captureAnchor(lines, s, e)
        const tracked = { start: s, end: e }
        return {
          s, e,
          found: Object.entries(edits(lines, s, e)).map(([kind, now]) => {
            const r = anchor(now, a.text, a.before, a.after, tracked)
            return { kind, result: r, stale: r.stale ? staleKind(now, a, r.loc) : undefined }
          }),
        }
      }),
    }
  })
  expectGolden(AREA, 'anchor.v2', out)
  const lines = read('examples/shop/api/orders.js').split('\n')
  const block = lines.slice(5, 9)
  expectGolden(AREA, 'anchor.helpers', {
    relocate: [0, 5, 20].map((hint) => [hint, relocate(['', ...lines], block, lines.slice(3, 5), lines.slice(9, 11), hint) ?? null]),
    closest: [0, 5, 30].map((t) => [t, closest(lines.map((l) => l.replace('const', 'let')), block, lines.slice(3, 5), lines.slice(9, 11), t) ?? null]),
    diff: [lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']), lineDiff([], ['x']), lineDiff(['x'], [])],
  })
})

test('golden: compact anchors (v3): made, converted, found again after edits', () => {
  const cases: { name: string; lines: string[]; anchor: CompactAnchor; hint: number }[] = JSON.parse(read('test/fixtures/compact-cases.json'))
  expectGolden(AREA, 'compact.cases', cases.map((c) => ({ name: c.name, found: findCompact(c.lines, c.anchor, c.hint) })))
  const out = shopFiles.map((f) => {
    const lines = read(`examples/shop/${f}`).split('\n')
    const spans = [[0, 0], [2, 6], [Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 1], [lines.length - 3, lines.length - 1]]
    return {
      file: f,
      spans: spans.map(([s, e]) => {
        const a = compactOf(lines, s, e)
        return { s, e, anchor: a ?? null, found: a ? Object.entries(edits(lines, s, e)).map(([kind, now]) => ({ kind, found: findCompact(now, a, s) })) : null }
      }),
    }
  })
  expectGolden(AREA, 'compact.shop', out)
  const legacy = legacyNotes.map((f) => JSON.parse(read(`${LEGACY}/${f}`)).anchor)
  expectGolden(AREA, 'compact.converted', {
    fromNotes: legacy.map((a) => toCompact(a) ?? null),
    blank: [toCompact({ text: '', before: 'x', after: '' }) ?? null, toCompact({ text: '\n\n', before: '', after: '' }) ?? null, compactOf(['', '', ''], 0, 2) ?? null],
    hashes: [[], [''], ['a'], ['  a  ', '', 'b;'], ["x = 'y'", 'x = "y"']].map((b) => blockHash(b)),
  })
})
