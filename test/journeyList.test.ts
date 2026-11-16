import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HERE_CAP, ListItem, ageOf, areaOf, buildList, matchScore, seeAlso } from '../src/journeyList'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { items, NOW } = require('../../test/journey-list/fixture.js')

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
  assert.equal(matchScore(items()[0], 'orders nothinglikethis').score, 0)
  assert.ok(matchScore(items()[0], 'orders').score > matchScore(items()[0], 'api').score, 'a title hit weighs more than a path hit')
  assert.equal(m.fallback, undefined)
})

test('search: no journey has every word: any word, and one line says which word nothing mentions', () => {
  const m = buildList(items(), { query: 'zebra retry', now: NOW })
  assert.ok(m.count > 0)
  assert.ok(m.sections[0].keys.some((k) => m.rows[k].title === 'How charging work'))
  assert.deepEqual(m.fallback, { missing: ['zebra'], note: 'Nothing mentions “zebra”; showing “retry”' })
  // Every word is somewhere, never together.
  const b = buildList(items(), { query: 'cart refunds', now: NOW })
  assert.equal(b.fallback?.note, 'No journey has every word; showing any')
  // One word that matches nothing: no fallback, nothing found.
  assert.equal(buildList(items(), { query: 'zebra', now: NOW }).count, 0)
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
  const it = (key: string, steps: [string, number, number][]): ListItem => ({ key, kind: 'journey', title: key, question: '', summary: '', files: steps.map((x) => x[0]), stepTitles: steps.map(() => ''), ranges: steps.map((x) => ({ start: x[1], end: x[2] })), steps: steps.length, stale: 0, isNew: false, resume: 0 })
  const a = it('a', [['web/x.ts', 1, 5], ['api/orders.js', 10, 20], ['api/orders.js', 40, 50]])
  const b = it('b', [['api/orders.js', 60, 70]])
  const c = it('c', [['api/store.js', 1, 9]])
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 62, end: 64 }), { key: 'b', step: 1 })
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 44, end: 45 }), { key: 'a', step: 3 })
  // No step on those lines: the journey with more steps in the file, at its nearest step.
  assert.deepEqual(seeAlso([a, b, c], ['api/orders.js'], { start: 25, end: 26 }), { key: 'a', step: 2 })
  // Several files (a tour's): the journey with most steps in them, at its first one there.
  assert.deepEqual(seeAlso([a, b, c], ['api/store.js', 'web/x.ts', 'api/orders.js']), { key: 'a', step: 1 })
  assert.equal(seeAlso([a, b, c], ['worker/w.js']), undefined)
  assert.equal(seeAlso([{ ...a, kind: 'check' }], ['web/x.ts']), undefined, 'checks are never "see also"')
})
