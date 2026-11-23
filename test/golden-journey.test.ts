// Golden tests (test/README.md): the journey model as it reads today, byte for byte. Parsing and its problems, the
// parts of a step (anchors, code links, value hints, marks), a step card's text, where a step's code is found, the
// list's model and search, and the pure parts of the map's layout (media/journey-layout.js).
// The list's dates are local time ("3 Nov 14:05"): this file runs in UTC, whatever the machine's zone.
process.env.TZ = 'UTC'
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import { expectGolden } from './golden'
import { Journey, parseJourney, readAnchor, readLinks, readValues, isGeneric, isOldFormat } from '../src/journeyModel'
import { codeMarkOf, findMark, markCodeProblem, markShapeProblem, readMarks, walkMarks } from '../src/marks/model'
import { codeLinkMarkup, linkPhrases, PH } from '../src/codeLinkText'
import { capValue, escapeTags, linkPaths } from '../src/journeys/textFormat'
import { dropAsides, refFiles, refsIn, shortPaths, staleText, stepText, StepRef, StepTextInput, TextJourney } from '../src/tour/stepText'
import { captureStepAnchor, placeStep, StepAt, writtenAt } from '../src/journeys/steps'
import { matchScore, queryWords, scoreJourney, tellingWords } from '../src/match'
import { ageOf, areaOf, buildList, seeAlso, stamp } from '../src/journeyList'
import { NOW, items } from './fixtures/journeyList'

const AREA = 'journey'
const root = path.join(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

/** Every journey file in the repository's fixtures, by a short name. */
const FIXTURES: Record<string, string> = {
  'shop-place-order': 'examples/shop/journeys/place-order.json',
  'fixture-place-order': 'test/fixtures/journey/journeys/place-order.json',
  'fixture-order-lifecycle': 'test/fixtures/journey/journeys/order-lifecycle.json',
  'scene-sample': 'test/journey-scene/sample.json',
}
const parsed = (name: string) => parseJourney(read(FIXTURES[name]), name) as Journey

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

// ---------- step text: code links, paths, the card ----------

test('golden: code links in each step of the shop journey, and their markup', () => {
  const j = parsed('shop-place-order')
  const out = j.steps.map((s) => {
    const links = readLinks(s.links)
    const used = new Set<number>()
    const lead = linkPhrases(s.lead, links, used, PH)
    const details = linkPhrases(s.details ?? '', links, used, PH)
    return { id: s.id, lead, details, unused: links.map((_, i) => i).filter((i) => !used.has(i)), markup: links.map((l, i) => codeLinkMarkup(`k|${s.id}`, i, l, l.phrase)) }
  })
  // A phrase inside a link or code, overlapping another, used before.
  const tricky = linkPhrases('See [the queue](x) and `the queue` then the queue and the queue job.', [
    { phrase: 'the queue', file: 'a', start: 1, end: 1, text: '' }, { phrase: 'queue job', file: 'b', start: 2, end: 3, text: '' }, { phrase: 'and', file: 'c', start: 1, end: 1, text: '' },
  ], new Set([2]), (i, p) => `<${i}:${p}>`)
  expectGolden(AREA, 'code-links', { steps: out, tricky, markupTint: codeLinkMarkup('k', 0, { file: 'a/b.ts', start: 4, end: 4 }, 'one  two', 'red', 'why') })
})

/** Text with the paths steps name: links, asides, tags, code. */
const TEXTS = [
  'See api/orders.go:12 and `web/src/a.ts:3-5`, also (worker/w.go#L9) and [x](api/orders.go:3).',
  'A <name> and <id> outside `code <x>` and ```\n<block>\n```, \\<kept\\>.',
  'Asides go (orders.go:12) here (`api/a.ts:3–4`) but not (see orders.go).',
  'No paths at all: README, a.ts, ./x/y.js:3 and ../z/w.ts:4 and dir/file.tsx#L10.',
]

test('golden: paths in step text: linked, shortened, asides dropped, tags escaped', () => {
  const link = (text: string, file: string, line: number) => `{${text}|${file}|${line}}`
  expectGolden(AREA, 'text-format', TEXTS.map((t) => ({
    in: t, linked: linkPaths(t, link), short: shortPaths(t), noAsides: dropAsides(t), escaped: escapeTags(t), refs: refsIn(t),
  })).concat([{ capped: ['', 'short', 'x'.repeat(40), `${'y'.repeat(38)}  tail`, 'z'.repeat(41)].map((v) => capValue(v)) } as never]))
})

const loaded = (j: Journey, at?: StepAt[]): TextJourney => ({ folder: { uri: { toString: () => 'file:///w' } }, j, at: at ?? writtenAt(j) })
const cardLink = (r: StepRef) => `[${r.label}](${r.file}:${r.line}-${r.end}${r.gone ? ' gone' : ''}${r.stale ? ' stale' : ''})`
const noFacts = (o: Partial<StepTextInput> = {}): StepTextInput => ({ renames: new Map(), refGone: new Set(), refLines: new Map(), detailsOpen: false, ...o })

test('golden: each step card\'s text, as written, moved, stale, with renames and gone files', () => {
  for (const name of Object.keys(FIXTURES)) {
    const j = parsed(name)
    const cards = j.steps.map((s, i) => {
      const n = i + 1
      const files = [...refFiles(s)]
      const moved = writtenAt(j).map((a) => ({ ...a, start: a.start + 3, end: a.end + 3 }))
      const stale = writtenAt(j).map((a) => ({ ...a, stale: true, was: 'old' }))
      const removed = writtenAt(j).map((a) => ({ ...a, stale: true, removed: true }))
      // The first file a step names, renamed; the second gone; the third only 5 lines long.
      const facts = noFacts({
        detailsOpen: true,
        renames: new Map(files.slice(0, 1).map((f) => [f, `moved/${f.split('/').pop()}`])),
        refGone: new Set(files.slice(1, 2).map((f) => `file:///w|${f}`)),
        refLines: new Map(files.slice(2, 3).map((f) => [`file:///w|${f}`, 5])),
      })
      return {
        id: s.id, files,
        written: stepText(loaded(j), n, cardLink, noFacts()),
        movedDown3: stepText(loaded(j, moved), n, cardLink, noFacts()),
        detailsOpenWithFacts: stepText(loaded(j), n, cardLink, facts),
        stale: stepText(loaded(j, stale), n, cardLink, noFacts()),
        staleBanner: [staleText(loaded(j, stale), n, 'Ask to refresh', false), staleText(loaded(j, removed), n, 'Ask', false), staleText(loaded(j), n, 'Ask', true), staleText(loaded(j), n, 'Ask', false)],
      }
    })
    expectGolden(AREA, `step-text.${name}`, cards)
  }
})

// ---------- where a step's code is found (the shop's journey on the shop's code) ----------

test('golden: the shop journey\'s steps placed in their code: as is, moved, edited, removed', () => {
  const j = parsed('shop-place-order')
  const shop = (f: string) => read(`examples/shop/${f}`).split('\n')
  const out = j.steps.map((s) => {
    const lines = shop(s.file)
    const was: StepAt = { ...s.range, stale: false }
    const a = s.anchor ?? captureStepAnchor(lines, s.range)
    const shifted = ['// one', '// two', '// three', ...lines]
    const edited = lines.map((l, i) => (i === s.range.start ? `${l} // edited` : l))
    const removed = [...lines.slice(0, s.range.start - 1), ...lines.slice(s.range.end)]
    return {
      id: s.id, file: s.file, range: s.range,
      captured: captureStepAnchor(lines, s.range),
      asIs: placeStep(lines, a, was, {}),
      moved: placeStep(shifted, a, was, { file: 'renamed.js' }),
      edited: placeStep(edited, a, was, {}),
      removed: placeStep(removed, a, was, {}),
    }
  })
  expectGolden(AREA, 'placed.shop-place-order', out)
})

// ---------- search and the Journeys list ----------

const QUERIES = ['retry', 'retr', 'How are charges retried?', 'the', 'zebra retry', 'cart refunds', 'api/store.js', 'order_id', 'Ünïcode café', '']

test('golden: the words of a search and of a question', () => {
  expectGolden(AREA, 'match.words', QUERIES.map((q) => ({ q, query: queryWords(q), telling: tellingWords(q) })))
})

test('golden: fixture journeys scored against searches and questions', () => {
  const js = Object.keys(FIXTURES).map(parsed)
  const questions = ['How does placing an order work?', 'What happens when a payment fails and is retried?', 'Why is the order cancelled after a timeout?', 'How does the worker pick up jobs from the queue?', 'explain the whole app']
  expectGolden(AREA, 'match.scores', js.map((j) => {
    const text = { title: j.title, question: j.question, summary: j.summary, stepTitles: j.steps.map((s) => s.title), files: j.steps.map((s) => s.file) }
    return {
      id: j.id,
      search: QUERIES.map((q) => ({ q, all: matchScore(text, q), any: matchScore(text, q, true) })),
      questions: questions.map((q) => ({ q, ...scoreJourney({ title: j.title, question: j.question, summary: j.summary, steps: j.steps.map((s) => s.title) }, q) })),
    }
  }))
})

test('golden: the Journeys list model (35 journeys): sorts, searches, chips, the active file', () => {
  const list = items()
  const cases: [string, Parameters<typeof buildList>[1]][] = [
    ['default', {}],
    ['newest', { sort: 'newest' }],
    ['walked', { sort: 'walked' }],
    ['name', { sort: 'name' }],
    ['search-retry', { query: 'retry' }],
    ['search-retry-newest', { query: 'retry', sort: 'newest' }],
    ['search-fallback', { query: 'zebra retry' }],
    ['search-any', { query: 'cart refunds', searchSort: 'name' }],
    ['search-none', { query: 'zebra' }],
    ['chip-stale', { area: 'stale' }],
    ['chip-area', { area: 'worker', sort: 'name' }],
    ['kind-check', { kind: 'check' }],
    ['here', { activeFile: 'api/store.js', activeSpan: { start: 60, end: 80 } }],
    ['here-all', { activeFile: 'api/store.js', hereAll: true, area: 'here' }],
  ]
  // The rows depend only on the items, the active file and the search (rowOf), and on Newest (ties of the same age say
  // when): those cases keep them in full; in the others, only what a search adds to a row (its hits); the active file's cases keep them too.
  const FULL = ['default', 'newest', 'search-retry', 'here', 'here-all']
  for (const [name, o] of cases) {
    const m = buildList(list, { now: NOW, ...o })
    const hits = Object.fromEntries(Object.entries(m.rows).filter(([, r]) => r.hits.length).map(([k, r]) => [k, r.hits]))
    expectGolden(AREA, `list.${name}`, FULL.includes(name) ? m : { ...m, rows: `${Object.keys(m.rows).length} rows, as in list.default`, hits })
  }
})

test('golden: list helpers: area, age, stamp, see also', () => {
  const list = items()
  const day = 86_400_000
  expectGolden(AREA, 'list.helpers', {
    area: [[], ['README.md'], ['api/a.js', 'web/b.js'], ['api/a.js', 'web/b.js', 'web/c.js'], ['x.js', 'y.js', 'api/z.js']].map((f) => [f, areaOf(f)]),
    age: [undefined, 'nope', new Date(NOW + day).toISOString(), new Date(NOW - day / 2).toISOString(), ...[1, 13, 14, 59, 60, 364, 365, 800].map((d) => new Date(NOW - d * day).toISOString())].map((a) => [a, ageOf(a, NOW)]),
    stamp: [0, NOW, NOW + 13 * 3_600_000 + 5 * 60_000, Date.parse('2026-02-28T23:59:59Z')].map((t) => [t, stamp(t)]),
    seeAlso: [
      [['api/store.js'], undefined], [['api/store.js'], { start: 70, end: 75 }], [['web/cart.js']], [['worker/charging.js', 'api/store.js']], [['nowhere.js']],
    ].map(([files, span]) => ({ files, span, at: seeAlso(list, files as string[], span as never) })),
  })
})

// ---------- the map's layout (media/journey-layout.js): its pure parts ----------

const media = path.join(root, 'media')
const window: Record<string, any> = { JourneyModel: {} }
const context = vm.createContext({ window })
for (const f of ['common.js', 'journey-layout.js']) vm.runInContext(fs.readFileSync(path.join(media, f), 'utf8'), context)
const L = window.JourneyLayout

test('golden: the map layout\'s pure parts for each fixture journey', () => {
  for (const name of Object.keys(FIXTURES)) {
    const j = parsed(name)
    const byId = new Map(j.nodes.map((n) => [n.id, n]))
    expectGolden(AREA, `layout.${name}`, {
      signature: L.signature(j),
      stepsOf: [...L.stepsOf(j)],
      ancestors: j.nodes.map((n) => [n.id, L.ancestors(byId, n.id)]),
      verbs: j.edges.map((e) => [e.label, L.verb(e.label)]),
    })
  }
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 21 }]
  const bez = [{ x: 0, y: 0 }, { x: 10, y: 40 }, { x: 50, y: -10 }, { x: 60, y: 30 }]
  expectGolden(AREA, 'layout.geometry', {
    pathD: [L.pathD([]), L.pathD(pts.slice(0, 1)), L.pathD(pts.slice(0, 2)), L.pathD(pts)],
    curveD: L.curveD(bez),
    samplesPolyline: L.samples({ pts }),
    samplesCurve: L.samples({ bez }),
  })
})
