import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HERE_CAP, ListItem, ageOf, areaOf, buildList, seeAlso } from '../src/core/list/journeyList'
import { NOW, items } from './fixtures/journeyList'
// The word-level rules the list's search uses (queryWords, stem, matchScore: src/core/list/match.ts) are tested in match.test.ts.

/** A journey item titled `title` whose steps (all in api/x.js) have these titles. */
const journeyItem = (key: string, title: string, steps: string[], summary = ''): ListItem => ({
  key, kind: 'journey', title, question: `How does ${title.toLowerCase()} work?`, summary,
  files: steps.map(() => 'api/x.js'), stepTitles: steps, steps: steps.length, stale: 0, isNew: false, resume: 0,
})

/** A journey item named `key` with steps at [file, start, end]. */
const itemWithSteps = (key: string, steps: [string, number, number][]): ListItem => ({
  key, kind: 'journey', title: key, question: '', summary: '',
  files: steps.map((x) => x[0]), stepTitles: steps.map(() => ''), ranges: steps.map((x) => ({ start: x[1], end: x[2] })),
  steps: steps.length, stale: 0, isNew: false, resume: 0,
})

test('area: the top folder most steps visit; ties go to the first step\'s', () => {
  assert.equal(areaOf(['api/a.js', 'web/b.js', 'web/c.js']), 'web')
  assert.equal(areaOf(['api/a.js', 'web/b.js']), 'api')
  assert.equal(areaOf(['README.js']), '(root)')
})

test('age', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  assert.deepEqual(['2026-11-16T08:00:00Z', '2026-11-13T00:00:00Z', '2026-10-20T00:00:00Z', '2026-06-01T00:00:00Z', '2024-01-01T00:00:00Z', undefined].map((a) => ageOf(a, now)), ['today', '3 d', '3 wk', '5 mo', '2 y', ''])
})

test('search finds words in step titles, not only titles; every word must match', () => {
  const m = buildList(items(), { query: 'retry', now: NOW })
  const keys = m.sections[0].keys
  const titles = keys.map((k) => m.rows[k].title)
  assert.ok(titles.includes('How charging work'), `found by its step "retries": ${titles}`)
  assert.ok(m.rows[keys.find((k) => m.rows[k].title === 'How charging work')!].hits.includes('retries'))
  assert.equal(m.fallback, undefined)
})

test('search: no journey has every word: any word, and one line says which word nothing mentions', () => {
  const m = buildList(items(), { query: 'zebra retry', now: NOW })
  assert.ok(m.count > 0)
  assert.ok(m.sections[0].keys.some((k) => m.rows[k].title === 'How charging work'))
  assert.deepEqual(m.fallback, { missing: ['zebra'], note: 'No journey about “zebra”; closest for “retry”' })
  // Every word is somewhere, never together.
  const b = buildList(items(), { query: 'cart refunds', now: NOW })
  assert.equal(b.fallback?.note, 'No journey has every word; showing any')
  // One word that matches nothing: no fallback, nothing found.
  assert.equal(buildList(items(), { query: 'zebra', now: NOW }).count, 0)
})

test('a question asked as one would ask it: retry journeys first', () => {
  const list = [
    journeyItem('totals', 'Order totals and discounts', ['Totals are summed', 'A discount code is applied'], 'How the totals of an order are computed and what the discounts are.'),
    journeyItem('errors', 'Unexpected server errors', ['The error handler logs it', 'The client gets a 500']),
    journeyItem('setup', 'Discount code setup', ['An admin adds a code']),
    journeyItem('backoff', 'Job retry backoff', ['A failed job waits longer each time']),
    journeyItem('queue', 'Worker job queue', ['A job is taken', 'A failed job is retried later']),
    journeyItem('email', 'Order confirmation email', ['The email is queued', 'A failed send is retried']),
    journeyItem('routing', 'API request routing', ['A route is matched']),
  ]
  const m = buildList(list, { query: 'how are charges retried' })
  const keys = m.sections[0].keys
  assert.deepEqual(keys.slice(0, 3), ['backoff', 'email', 'queue'], `retry journeys first: ${keys}`)
  assert.equal(keys.length, 3, 'stop-words match nothing')
  assert.equal(m.fallback?.note, 'No journey about “charges”; closest for “retried”')
  // A journey with both words comes first.
  const both = buildList([...list, journeyItem('charge', 'Card charges', ['A declined charge is retried once'])], { query: 'how are charges retried' })
  assert.equal(both.sections[0].keys[0], 'charge'); assert.equal(both.fallback, undefined)
})

test('Newest: ties of the same age say when; a search keeps the sort that was picked', () => {
  const n = buildList(items(), { sort: 'newest', now: NOW })
  const rows = n.sections.at(-1)!.keys.map((k) => n.rows[k])
  const ages = rows.map((r) => r.age)
  // Every age shown once, or a time that tells them apart.
  assert.equal(new Set(ages).size, ages.length, `no ties: ${ages.join(', ')}`)
  assert.ok(ages.some((a) => /^\d+ [A-Z][a-z]{2} \d\d:\d\d$/.test(a)), `a date and time where ages tied: ${ages.join(', ')}`)
  assert.ok(rows.every((r, i) => i === 0 || Date.parse(rows[i - 1].createdAt!) >= Date.parse(r.createdAt!)), 'newest first')
  // The default sort (by area) searches by best match; a picked sort orders the results too.
  assert.equal(buildList(items(), { query: 'work', now: NOW }).searchSort, 'best')
  const s = buildList(items(), { query: 'work', sort: 'newest', now: NOW })
  assert.equal(s.searchSort, 'newest')
  const found = s.sections[0].keys.map((k) => Date.parse(s.rows[k].createdAt!))
  assert.deepEqual(found, [...found].sort((a, b) => b - a), 'search results newest first')
  assert.equal(buildList(items(), { query: 'work', sort: 'newest', searchSort: 'best', now: NOW }).searchSort, 'best')
})

test('sections: Continue, In <file>, New, then by area; the sidebar\'s groups from the same model; no checks', () => {
  const m = buildList(items(), { activeFile: 'api/store.js', now: NOW })
  assert.deepEqual(m.sections.map((s) => s.id).slice(0, 3), ['continue', 'here', 'new'])
  assert.equal(m.sections[1].label, 'In store.js')
  assert.ok(m.sections.slice(3).every((s) => s.id.startsWith('area:')))
  assert.deepEqual(m.groups.map((g) => g.id), ['here', 'continue', 'all'])
  assert.deepEqual(m.groups[2].children!.map((c) => c.label), ['api', 'config', 'payments', 'web', 'worker'])
  assert.equal(m.rows.k1.meta, 'api · 5 steps · 3 d')
  // One count everywhere: the panel's total is the sidebar's All.
  assert.equal(m.total, m.groups[2].children!.reduce((a, c) => a + c.keys.length, 0))
  // Sorted by date: one flat "Newest" section after the personal ones; the sidebar's All is flat too.
  const n = buildList(items(), { sort: 'newest', now: NOW })
  assert.equal(n.sections.at(-1)!.label, 'Newest')
  assert.equal(n.rows[n.sections.at(-1)!.keys[0]].key, 'k1')
  assert.equal(n.groups.at(-1)!.children, undefined)
  assert.equal(buildList(items(), { area: 'config', now: NOW }).count, 3)
})

test('Continue: past step 1 only (opening is not reading), the walk being walked first', () => {
  const its = items()
  its[0].resume = 1
  its[1].resume = 1; its[1].walking = true
  const m = buildList(its, { now: NOW })
  const cont = m.sections.find((s) => s.id === 'continue')!.keys
  assert.ok(!cont.includes('k1'), 'left at step 1: not Continue')
  assert.equal(cont[0], 'k2', 'the walk itself, first')
  assert.ok(cont.includes('k13') && cont.includes('k26'))
})

test('In this file: ranked (a step at the cursor\'s function, then steps here), capped with "more", in full on demand', () => {
  const m = buildList(items(), { activeFile: 'api/store.js', activeSpan: { start: 136, end: 136 }, now: NOW })
  const here = m.sections.find((s) => s.id === 'here')!
  assert.equal(here.keys.length, HERE_CAP)
  assert.equal(here.more, 2)
  assert.equal(here.keys[0], 'k25', 'its step is at the cursor')
  assert.deepEqual(here.keys.slice(1, 4).sort(), ['k10', 'k20', 'k30'], 'then two steps here')
  assert.equal(m.rows.k10.hereText, '2 of 7 steps here')
  assert.equal(m.groups[0].keys.length, HERE_CAP)
  assert.equal(m.groups[0].more, 2)
  const all = buildList(items(), { activeFile: 'api/store.js', hereAll: true, now: NOW })
  assert.equal(all.sections.find((s) => s.id === 'here')!.keys.length, 7)
  assert.equal(all.groups[0].more, undefined)
  // The "In store.js" chip: one section, every one of them.
  const chip = buildList(items(), { activeFile: 'api/store.js', area: 'here', now: NOW })
  assert.deepEqual(chip.sections.map((s) => s.id), ['here'])
  assert.equal(chip.count, 7)
})

test('Stale: a chip with its count; rows say which steps', () => {
  const m = buildList(items(), { now: NOW })
  assert.equal(m.staleCount, 3)
  const s = buildList(items(), { area: 'stale', now: NOW })
  assert.equal(s.count, 3)
  assert.ok(Object.values(s.rows).filter((r) => r.stale).every((r) => r.staleSteps!.length === 2))
})

test('See also: the journey step on those lines first, then the journey with most steps in the file, then the nearest step', () => {
  const a = itemWithSteps('a', [['web/x.ts', 1, 5], ['api/orders.js', 10, 20], ['api/orders.js', 40, 50]])
  const b = itemWithSteps('b', [['api/orders.js', 60, 70]])
  const c = itemWithSteps('c', [['api/store.js', 1, 9]])
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 62, end: 64 }), { key: 'b', step: 1 })
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 44, end: 45 }), { key: 'a', step: 3 })
  // No step on those lines: the journey with more steps in the file, at its nearest step.
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 25, end: 26 }), { key: 'a', step: 2 })
  // Several files (a tour's): the journey with most steps in them, at its first one there.
  assert.deepEqual(seeAlso([a, b, c], ['api/store.js', 'web/x.ts', 'api/orders.js']), { key: 'a', step: 1 })
  assert.equal(seeAlso([a, b, c], ['worker/w.js']), undefined)
  assert.equal(seeAlso([{ ...a, kind: 'check' }], ['web/x.ts']), undefined, 'checks are never "see also"')
})
