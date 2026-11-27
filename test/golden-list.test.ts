// Golden tests (test/README.md): the Journeys list's model and search as they work today, byte for byte.
// The list's dates are local time ("3 Nov 14:05"): this file runs in UTC, whatever the machine's zone.
process.env.TZ = 'UTC'
import { test } from 'node:test'
import { expectGolden } from './golden'
import { FIXTURES, parsed } from './goldenJourneys'
import { matchScore, queryWords, scoreJourney, tellingWords } from '../src/core/list/match'
import { FLAT_UNDER, ageOf, areaOf, buildList, seeAlso, stamp } from '../src/core/list/journeyList'
import { NOW, items } from './fixtures/journeyList'

const AREA = 'journey'

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

test('golden: the Journeys view\'s groups for a few journeys and for more, and a walked journey', () => {
  const plain = items().map((it) => ({ ...it, resume: 0, walkedAt: undefined }))
  const groups = (l: typeof plain) => {
    const m = buildList(l, { now: NOW })
    return { flat: m.flat, groups: m.groups }
  }
  expectGolden(AREA, 'list.groups', {
    one: groups(plain.slice(0, 1)),
    few: groups(plain.slice(0, FLAT_UNDER - 1)),
    nine: groups(plain.slice(0, 9)),
    oneWalked: groups([{ ...plain[0], resume: 1, walking: true }]),
    nineOneWalked: groups([{ ...plain[0], resume: 1, walking: true }, ...plain.slice(1, 9)]),
  })
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
