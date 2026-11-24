import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { staleKind } from '../src/core/anchors/staleDiff'
import { isOldFormat, parseJourney, readJourney, readValues } from '../src/core/format/journeyModel'
import { capValue, linkPaths } from '../src/journeys/textFormat'
import { escapeTags } from '../src/core/escape'
import { journeyOf } from './formats'

/** Why parseJourney refuses `raw` (the test fails when it reads it). */
function refusal(raw: string): string {
  const r = parseJourney(raw, 'x')
  assert.equal(r.ok, false, 'refused')
  return r.ok ? '' : r.why
}

const fixture = fs.readFileSync(path.join(__dirname, '../../test/fixtures/journey/journeys/v2-full.json'), 'utf8')
const j = journeyOf(fixture, 'place-order')

test('the v2 journey parses: 21 nodes, 13 edges, 13 embedded steps, numbered by position, with ids', () => {
  assert.equal(parseJourney(fixture, 'place-order').ok, true)
  assert.deepEqual([j.nodes.length, j.edges.length, j.steps.length], [21, 13, 13])
  assert.deepEqual(j.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  const s3 = j.steps[2]
  assert.equal(s3.id, 'pending-record')
  assert.equal(s3.file, 'api/orders.go')
  assert.deepEqual(s3.range, { start: 82, end: 114 })
  assert.ok(s3.anchor && 'text' in s3.anchor && s3.anchor.text.length > 0)
  assert.ok(s3.lead.split(/\s+/).length <= 40)
  assert.ok(j.steps.every((s) => s.refs.length <= 3))
  assert.deepEqual(j.problems, [], 'the fixture keeps the rules')
})

test('v1 (steps as notes) is refused with a reason the extension can log once', () => {
  const v1 = fs.readFileSync(path.join(__dirname, '../../test/fixtures/journey/legacy/v1.json'), 'utf8')
  assert.match(refusal(v1), /^format v1/)
})

test('unusable files are refused with a reason; bad parts are dropped', () => {
  assert.match(refusal('{'), /not valid JSON/)
  assert.match(refusal('[]'), /object/)
  assert.match(refusal('{"version":2,"nodes":[],"steps":[]}'), /nodes/)
  assert.match(refusal('{"version":2,"nodes":[{"id":"a"}]}'), /steps/)
  const loose = journeyOf(JSON.stringify({
    version: 2,
    nodes: [{ id: 'a', kind: 'system', label: 'A' }, { id: 'b', kind: 'weird', parent: 'nope' }, { id: 'c', parent: 'd' }, { id: 'd', parent: 'c' }, { id: 'a' }],
    edges: [{ from: 'a', to: 'b', label: 'x' }, { from: 'a', to: 'zzz' }, { from: 'a', to: 'a' }],
    steps: [{ node: 'zzz', file: 'f.ts', range: { start: 1 } }, { node: 'b', title: 'T', file: 'f.ts', range: { start: 3, end: 2 }, refs: ['a:1', 'b:2', 'c:3', 'd:4'] }, { node: 'a' }],
  }), 'file-name')
  assert.deepEqual(loose.nodes.map((n) => n.id), ['a', 'b', 'c', 'd'], 'duplicate id dropped')
  assert.equal(loose.nodes[1].kind, 'module')
  assert.equal(loose.nodes[1].parent, undefined, 'unknown parent: top level')
  assert.ok(loose.nodes.filter((n) => n.id === 'c' || n.id === 'd').some((n) => n.parent === undefined), 'parent loop broken')
  assert.equal(loose.edges.length, 1)
  assert.deepEqual(loose.steps, [{ id: '#1', n: 1, title: 'T', node: 'b', file: 'f.ts', range: { start: 3, end: 3 }, lead: '', refs: ['a:1', 'b:2', 'c:3'] }])
  assert.equal(loose.id, 'file-name')
  // Every dropped part is a problem the map shows.
  for (const re of [/defined twice/, /parent "nope" doesn't exist/, /makes a loop/, /arrow from "A" to a box that doesn.t exist \("zzz"\)/, /step 1 .*unknown box/, /step 3 .*no file/, /4 references/]) {
    assert.ok(loose.problems.some((p) => re.test(p)), `${re}: ${loose.problems.join(' | ')}`)
  }
})

test('more than 7 children on a level: a problem for the author (the map still draws every box)', () => {
  const many = journeyOf(JSON.stringify({ version: 2, nodes: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, kind: 'system' })), steps: [{ node: 's8', file: 'x', range: { start: 1 } }] }), 'm')
  assert.equal(many.nodes.length, 9)
  assert.ok(many.problems.some((p) => /top level: 9 boxes/.test(p)))
})

test('blurb, path and edge detail are read, and optional', () => {
  const srv = j.nodes.find((n) => n.id === 'backend')!
  assert.equal(srv.blurb, 'HTTP API plus the order worker loop')
  assert.equal(srv.path, 'cmd/shop')
  assert.equal(j.nodes.find((n) => n.id === 'web')!.path, undefined)
  assert.ok(j.edges.some((e) => e.detail === 'validate first, then for real: POST /api/orders'))
  assert.ok(j.edges.every((e) => e.label.length <= 30), 'the map shows the short labels')
  // A journey without blurbs/paths/details still works.
  const bare = journeyOf(JSON.stringify({ ...JSON.parse(fixture), nodes: j.nodes.map(({ blurb, path, ...n }) => n), edges: j.edges.map(({ detail, ...e }) => e) }), 'bare')
  assert.ok(bare.nodes.every((n) => n.blurb === undefined && n.path === undefined))
  assert.ok(bare.edges.every((e) => e.detail === undefined))
  // Blank values are dropped.
  const blank = journeyOf(JSON.stringify({ version: 2, nodes: [{ id: 'a', blurb: '  ', path: '' }], edges: [], steps: [] }), 'x')
  assert.deepEqual(Object.keys(blank.nodes[0]).sort(), ['id', 'kind', 'label', 'summary'])
})

test('every path:line in step text is a link: in parentheses, in backticks, ranges; markdown links are left alone', () => {
  const t = 'Gates (worker/worker.go:725), `payments/status.go:47-50`, (a/b.go:733-744) and payments/client.go:160. ' +
    'Already a link: [x](a/b.go:3), [c/d.ts:4](command:x).'
  const got: string[] = []
  const out = linkPaths(t, (text, file, line) => { got.push(`${text}|${file}|${line}`); return '@' })
  assert.deepEqual(got, [
    'worker/worker.go:725|worker/worker.go|725',
    'payments/status.go:47-50|payments/status.go|47',
    'a/b.go:733-744|a/b.go|733',
    'payments/client.go:160|payments/client.go|160',
  ])
  assert.ok(out.includes('[x](a/b.go:3)') && out.includes('[c/d.ts:4](command:x)'))
})

test('a stale step tells an edit from a removal: a diff, or "removed" (never pinned to other code)', () => {
  const file = ['package x', '', 'func A() {', '  wait := 2', '  poll(wait)', '}', '', 'func B() {', '  other()', '}']
  const a = { text: 'func A() {\n  wait := 2\n  poll(wait)\n}', before: 'package x\n', after: '\nfunc B() {' }
  const edited = file.map((l) => (l === '  wait := 2' ? '  wait := 5' : l))
  assert.deepEqual(staleKind(edited, a, { start: 2, end: 5 }), { was: a.text, now: 'func A() {\n  wait := 5\n  poll(wait)\n}' })
  const removed = ['package x', '', 'func B() {', '  other()', '}', '', 'func C() {', '  more()', '}']
  assert.deepEqual(staleKind(removed, a, { start: 2, end: 5 }), { removed: true })
})

test('links in step details are links, also inside backticks and parentheses with ranges', () => {
  const d = 'A declined card fails at once, a provider timeout only after 3 retries (`payments/status.go:342-360`).'
  const out = linkPaths(d, (text, file, line) => `[${text}](ref:${file}:${line})`)
  assert.equal(out, 'A declined card fails at once, a provider timeout only after 3 retries ([payments/status.go:342-360](ref:payments/status.go:342)).')
})

test('<name> outside code stays text in the inline card; code spans and fences are untouched', () => {
  assert.equal(escapeTags('Else "Charging card <name>" (`order-<id>`)'), 'Else "Charging card \\<name\\>" (`order-<id>`)')
  assert.equal(escapeTags('a\n\n```\nif a < b {}\n```\n\nx > y'), 'a\n\n```\nif a < b {}\n```\n\nx \\> y')
  assert.equal(escapeTags('[f.go:3](command:x?%5B%22a%22%5D "t")'), '[f.go:3](command:x?%5B%22a%22%5D "t")')
})

test('kinds: a store is read as a store, an unknown kind as a module', () => {
  const k = journeyOf(JSON.stringify({
    version: 2,
    nodes: [{ id: 'srv', kind: 'system', label: 'Server' }, { id: 'rec', kind: 'store', label: 'Record', parent: 'srv' }, { id: 'odd', kind: 'whatever', label: 'Odd' }],
    edges: [{ from: 'odd', to: 'rec', label: 'polls', async: true }],
    steps: [{ node: 'srv', title: 'A', file: 'a.go', range: { start: 1 } }],
  }), 'x')
  assert.equal(k.nodes.find((n) => n.id === 'rec')!.kind, 'store')
  assert.equal(k.nodes.find((n) => n.id === 'odd')!.kind, 'module', 'an unknown kind is a module')
  assert.equal(k.edges[0].async, true)
})

test('readValues: a step\'s usable value hints, each value and note on one line', () => {
  assert.deepEqual(readValues(undefined), [])
  assert.deepEqual(readValues({ name: 'x' }), [])
  const ok = { name: ' objs ', value: '[Secret run-1,\n  Pod run-1]', file: ' src/a.ts ', line: 3, text: 'objs := list()', note: '  what  it  lists ' }
  assert.deepEqual(readValues([ok]), [{ name: 'objs', value: '[Secret run-1, Pod run-1]', file: 'src/a.ts', line: 3, text: 'objs := list()', note: 'what it lists' }])
  const bad = [{ ...ok, name: ' ' }, { ...ok, value: 3 }, { ...ok, line: 0 }, { ...ok, line: 1.5 }, { ...ok, file: undefined }, null]
  assert.deepEqual(readValues(bad), [])
  assert.deepEqual(readValues([{ ...ok, text: 5, note: ' ' }]), [{ name: 'objs', value: '[Secret run-1, Pod run-1]', file: 'src/a.ts', line: 3, text: '' }])
})

test('capValue: about 40 characters, the note survives', () => {
  assert.equal(capValue('short'), 'short')
  const long = 'x'.repeat(60)
  assert.equal(capValue(long).length, 40)
  assert.ok(capValue(long).endsWith('…'))
})

test('versions: only the current file version is read (VERSIONS.journey); an anchor\'s own `v` is not a file version', () => {
  const doc = (version: unknown) => JSON.stringify({ version, nodes: [{ id: 'a' }], steps: [] })
  assert.equal(parseJourney(doc(2), 'x').ok, true)
  const newer = refusal(doc(3))
  assert.equal(newer, 'format v3 is newer than this extension reads (v2)', 'no file was ever written as version 3')
  assert.equal(isOldFormat(newer), false, 'a newer file is not listed as one to migrate')
  assert.ok(isOldFormat(refusal(doc(1))))
  assert.match(refusal(doc(undefined)), /^format v1/)
})

test('a step\'s links and values are read with the step (the same rules as readLinks and readValues)', () => {
  const step = { node: 'a', file: 'f.ts', range: { start: 1 } }
  const links = [{ phrase: ' p ', file: 'f.ts', start: 2 }, { phrase: '', file: 'f.ts', start: 1 }]
  const values = [{ name: 'x', value: 'a\n b', file: 'f.ts', line: 1 }, { name: 'y' }]
  const got = journeyOf(JSON.stringify({ version: 2, nodes: [{ id: 'a' }], steps: [{ ...step, links, values }, { ...step, links: [{}], values: 'x' }] }), 'x')
  assert.deepEqual(got.steps[0].links, [{ phrase: 'p', file: 'f.ts', start: 2, end: 2, text: '' }])
  assert.deepEqual(got.steps[0].values, [{ name: 'x', value: 'a b', file: 'f.ts', line: 1, text: '' }])
  assert.equal(got.steps[1].links, undefined, 'none usable: left out')
  assert.equal(got.steps[1].values, undefined)
})

test('readJourney (a check\'s embedded tour): the steps it leaves out are listed apart from the other problems', () => {
  const r = readJourney({ version: 2, nodes: [{ id: 'a', label: 'A label longer than thirty characters!' }], steps: [{ node: 'b', file: 'f', range: { start: 1 } }, { node: 'a', file: 'f', range: { start: 1 } }] }, 'tour')
  assert.ok(r.ok)
  assert.deepEqual(r.value.stepsLeftOut, ['step 1 is in an unknown box "b": left out'])
  assert.equal(r.value.journey.problems.length, 2, 'the long label is a problem, not a step left out')
  assert.deepEqual(readJourney([], 'tour'), { ok: false, why: 'not a JSON object' })
})
