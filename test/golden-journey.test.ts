// Golden tests (test/README.md): the journey model as it reads today, byte for byte: parsing and its problems, the
// parts of a step (anchors, code links, value hints) and its marks.
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { expectGolden } from './golden'
import { FIXTURES, read, root } from './goldenJourneys'
import { parseJourney, readAnchor, readLinks, readValues, isGeneric, isOldFormat } from '../src/core/format/journeyModel'
import { codeMarkOf, findMark, markCodeProblem, markShapeProblem, readMarks, walkMarks } from '../src/marks/model'

const AREA = 'journey'

// ---------- parsing ----------

test('golden: every fixture journey as parseJourney reads it', () => {
  for (const [name, file] of Object.entries(FIXTURES)) expectGolden(AREA, `parse.${name}`, parseJourney(read(file), name))
  const legacy = 'test/fixtures/journey/legacy'
  for (const f of fs.readdirSync(path.join(root, legacy)).filter((x) => x.endsWith('.json')).sort()) {
    const why = parseJourney(read(`${legacy}/${f}`), f)
    expectGolden(AREA, `parse.legacy.${f.replace(/\.json$/, '')}`, { result: why, oldFormat: typeof why === 'string' && isOldFormat(why) })
  }
})

/** Journeys that break the rules, one way each: what parseJourney refuses (a string) or reads with problems. */
const node = (id: string, o: object = {}) => ({ id, kind: 'module', label: id.toUpperCase(), summary: `${id} summary`, ...o })
const okStep = (o: object = {}) => ({ id: 's', node: 'a', file: 'src/a.ts', range: { start: 3, end: 5 }, title: 'A step', lead: 'It does a thing.', refs: [], ...o })
const doc = (o: object) => JSON.stringify({ version: 2, id: 'bad', question: 'Q?', title: 'T', summary: 'S', nodes: [node('a'), node('b')], edges: [], steps: [okStep()], ...o })
const INVALID: [string, string][] = [
  ['not json', '{ "version": 2, '],
  ['an array', '[]'],
  ['null', 'null'],
  ['no version (v1)', JSON.stringify({ nodes: [node('a')], steps: [] })],
  ['version 1', JSON.stringify({ version: 1, nodes: [node('a')], steps: [] })],
  ['version 4', JSON.stringify({ version: 4, nodes: [node('a')], steps: [] })],
  ['nodes missing', JSON.stringify({ version: 2, steps: [] })],
  ['nodes empty', doc({ nodes: [] })],
  ['steps not an array', doc({ steps: {} })],
  ['minimal, no title/question/id', JSON.stringify({ version: 2, nodes: [{ id: 'x' }], steps: [] })],
  ['question only', JSON.stringify({ version: 3, question: 'Why?', nodes: [{ id: 'x' }], steps: [] })],
  ['node without id, twice-defined node, unknown kind', doc({ nodes: [node('a'), {}, node('a', { label: 'again' }), node('b', { kind: 'planet' })] })],
  ['parent missing, parent loop', doc({ nodes: [node('a', { parent: 'zz' }), node('b', { parent: 'c' }), node('c', { parent: 'b' })] })],
  ['edges: self, unknown ends, missing, generic, async', doc({ edges: [{ from: 'a', to: 'a', label: 'x' }, { from: 'a', to: 'nope', label: 'y' }, { to: 'b' }, null, { from: 'a', to: 'b', label: 'calls', detail: '  why  ', async: 1 }] })],
  ['steps: unknown box, no file, no range, null, bad lines', doc({ steps: [okStep({ node: 'zz', title: 'Lost' }), okStep({ file: '  ' }), okStep({ range: undefined }), null, okStep({ range: { start: 0, end: 2 } }), okStep({ id: 'fine', range: { start: 9, end: 4 } })] })],
  ['steps: too many refs, ids used twice, no id, blank title', doc({ steps: [okStep({ id: 'x', refs: ['a.ts:1', ' b.ts:2 ', '', 3, 'c.ts:3', 'd.ts:4'] }), okStep({ id: 'x' }), okStep({ id: '', title: '  ' })] })],
  ['long label, 8 boxes on one level, 8 inside one', doc({ nodes: [node('a', { label: 'A label far longer than thirty characters' }), ...'bcdefgh'.split('').map((c) => node(c)), node('p'), ...'12345678'.split('').map((c) => node(`p${c}`, { parent: 'p' }))] })],
  ['optional fields: model, commit, createdAt, start, blurb, path, lane, at', doc({ model: '  opus  ', commit: 'abc', createdAt: '2026-01-02T03:04:05Z', start: true, nodes: [node('a', { blurb: ' short ', path: ' src/ ', lane: 'side', at: { file: 'src/a.ts', start: 4, anchor: { v: 3, head: 'x\ny' } } }), node('b', { lane: 'top', blurb: '   ', at: { file: 'src/b.ts' } })] })],
  ['start not true, commit empty', doc({ start: 'yes', commit: '' })],
  ['scene: kept only with actors and beats', doc({ steps: [okStep({ id: 's1', scene: { actors: [], beats: [] } }), okStep({ id: 's2', scene: { actors: [{ id: 'x' }], beats: [{ focus: 'x', caption: 'c' }] } }), okStep({ id: 's3', scene: { beats: [{}] } })] })],
  ['links, values and marks are kept as written', doc({ steps: [okStep({ links: [], values: [{ name: 'x' }], marks: 'not a list' }), okStep({ id: 't', links: [{ phrase: 'p' }], marks: [] })] })],
  ['anchors: v2, v3, v3 without head, neither', doc({ steps: [okStep({ id: 'v2', anchor: { text: 'a', before: 1 } }), okStep({ id: 'v3', anchor: { v: 3, head: 'h1\nh2', lines: 0, hash: 'abc' } }), okStep({ id: 'v3-empty', anchor: { v: 3, head: '  ' } }), okStep({ id: 'none', anchor: { foo: 1 } })] })],
]

test('golden: journeys that break the rules: refused, or read with problems', () => {
  expectGolden(AREA, 'parse.invalid', INVALID.map(([name, raw]) => ({ name, result: parseJourney(raw, 'named-by-file') })))
})

test('golden: anchors, code links, value hints and generic labels as read', () => {
  const anchors = [undefined, null, 'text', {}, { text: 'a' }, { text: 'a', before: 'b', after: 'c', extra: 1 }, { v: 3, head: 'x' }, { v: 3, head: 'x\ny\nz', tail: '', lines: 7, hash: 'h', before: 'b' }, { v: 3, head: '', text: 't' }, { v: 2, text: 't' }]
  const links = [undefined, 'x', [null, {}, { phrase: ' the queue ', file: ' api/q.js ', start: 4 }, { phrase: 'p', file: 'f', start: 0 }, { phrase: 'p', file: 'f', start: 5, end: 2, text: 'line' }, { phrase: '  ', file: 'f', start: 1 }, { phrase: 'p', file: 3, start: 1 }, { phrase: 'q', file: 'f', start: 2, end: 9, text: 7 }]]
  const values = [undefined, {}, [null, { name: 'x', value: 'a\n  b', file: 'f', line: 1 }, { name: ' y ', value: '1', file: ' f ', line: 2, text: 'let y', note: '  in\tcents ' }, { name: 'z', value: 1, file: 'f', line: 1 }, { name: 'z', value: '', file: 'f', line: 0 }, { name: 'w', value: '', file: 'f', line: 3, note: ' ' }]]
  const labels = ['', '  ', 'calls', 'Calls per env', 'call', 'caller', 'recalls', 'enqueues']
  expectGolden(AREA, 'parts', {
    anchors: anchors.map((a) => ({ in: a, out: readAnchor(a) })),
    links: links.map((l) => ({ in: l, out: readLinks(l) })),
    values: values.map((v) => ({ in: v, out: readValues(v) })),
    generic: labels.map((l) => [l, isGeneric(l)]),
  })
})

// ---------- marks ----------

const CODE = [
  'export function placeOrder(cart, user) {',
  '  const total = cart.items.reduce((s, i) => s + i.price, 0)',
  '  if (total <= 0) throw new Error("empty cart")',
  '',
  '  const order = { user: user.id, total, status: "pending" }',
  '  return queue.push(order).then(() => order.status)',
  '}',
]

test('golden: marks as read, found in the code and checked', () => {
  const lists: unknown[] = [undefined, 'x', [], [null, 3, { lines: [2, 2] }, { lines: [3, 2] }, { lines: [0, 1] }, { lines: [1] }, { lines: [1, 2], file: '' }, { lines: [1, 2], file: 'web/a.ts', match: '' }, { lines: [1, 2], match: 'total', nth: 0 }, { lines: [1, 2], match: 'total', nth: 2, extra: true }, { lines: [1.5, 2] }]]
  const shapes = [{}, { lines: [1, 1] }, { lines: [2, 2], file: 7 }, { lines: [2, 2], nth: 'x' }, { lines: [2, 2], match: 5 }]
  const finds: object[] = [
    { lines: [2, 2], match: 'total' }, { lines: [2, 3], match: 'total', nth: 2 }, { lines: [2, 2], match: 'order' },
    { lines: [6, 6], match: 'total' }, { lines: [1, 1], match: 'nowhere' }, { lines: [4, 4] }, { lines: [5, 99] },
    { lines: [8, 9] }, { lines: [2, 3], match: 'cart")\n' }, { lines: [3, 5], match: '\n\n' }, { lines: [1, 7], match: 'order', nth: 5 },
  ]
  const problems = finds.map((m) => ({ mark: m, journey: markCodeProblem(CODE, 'api/orders.js', m as never, 'drop'), podcast: markCodeProblem(CODE, 'api/orders.js', m as never, 'lines') }))
  problems.push({ mark: { lines: [1, 1], file: 'x.js' }, journey: markCodeProblem(null, 'x.js', { lines: [1, 1], file: 'x.js' }, 'drop'), podcast: markCodeProblem(null, 'x.js', { lines: [1, 1] }, 'lines') })
  expectGolden(AREA, 'marks', {
    read: lists.map((v) => ({ in: v, out: readMarks(v) })),
    shape: shapes.map((m) => ({ in: m, problem: markShapeProblem(m), mark: markShapeProblem(m) ? undefined : codeMarkOf(m) })),
    find: finds.map((m) => ({ mark: m, found: findMark(CODE, m as never) })),
    problems,
    walk: [undefined, 0, 1, 2, 5].map((beat) => ({ beat, lit: walkMarks(['s1', 's2'], [['b0'], [], ['b2a', 'b2b']], beat) })).concat(
      [undefined, 1].map((beat) => ({ beat, lit: walkMarks([], [[], ['only']], beat) }))),
  })
})
