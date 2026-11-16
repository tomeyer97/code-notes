import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageOf, areaOf, buildList, matchScore } from '../src/journeyList'
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
  assert.ok(!m.rows[keys[0]].title.toLowerCase().includes('retr') || keys.length > 1)
  assert.ok(m.rows[keys.find((k) => m.rows[k].title === 'How charging work')!].hits.includes('retries'))
  assert.equal(matchScore(items()[0], 'orders nothinglikethis').score, 0)
  assert.ok(matchScore(items()[0], 'orders').score > matchScore(items()[0], 'api').score, 'a title hit weighs more than a path hit')
})

test('sections: Continue, In <file>, Checks, New, then by area; the sidebar\'s groups from the same model', () => {
  const m = buildList(items(), { activeFile: 'api/store.js', now: NOW })
  assert.deepEqual(m.sections.map((s) => s.id).slice(0, 4), ['continue', 'here', 'checks', 'new'])
  assert.equal(m.sections[1].label, 'In store.js')
  assert.ok(m.sections.slice(4).every((s) => s.id.startsWith('area:')))
  assert.deepEqual(m.groups.map((g) => g.id), ['here', 'continue', 'checks', 'all'])
  assert.deepEqual(m.groups[3].children!.map((c) => c.label), ['api', 'config', 'payments', 'web', 'worker'])
  assert.equal(m.rows.k1.meta, 'api · 5 steps · 3 d')
  assert.equal(m.rows['check:understanding/feat-x.json'].meta, '1/2 ✓ · today')
  // Sorted by date: one flat "Newest" section after the personal ones; the sidebar's All is flat too.
  const n = buildList(items(), { sort: 'newest', now: NOW })
  assert.equal(n.sections.at(-1)!.label, 'Newest')
  assert.equal(n.rows[n.sections.at(-1)!.keys[0]].key, 'k1')
  assert.equal(n.groups.at(-1)!.children, undefined)
  // Chips: kind and area filters.
  assert.equal(buildList(items(), { kind: 'check', now: NOW }).count, 1)
  assert.equal(buildList(items(), { area: 'config', now: NOW }).count, 3)
  assert.equal(buildList(items(), { area: 'here', activeFile: 'api/store.js', now: NOW }).count, m.sections[1].keys.length)
})
