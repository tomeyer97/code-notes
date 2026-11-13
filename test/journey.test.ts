import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { staleKind } from '../src/anchor'
import { isGeneric, Journey, linkPaths, escapeTags, parseJourney, stepRanges } from '../src/journeyModel'

const fixture = fs.readFileSync(path.join(__dirname, '../../test/fixtures/journey/journeys/place-order.json'), 'utf8')
const j = parseJourney(fixture, 'place-order') as Journey

test('the v2 journey parses: 21 nodes, 13 edges, 13 embedded steps, numbered by position, with ids', () => {
  assert.equal(typeof j, 'object')
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
  const v1 = fs.readFileSync(path.join(__dirname, '../../test/fixtures/journey/legacy/place-order-v1.json'), 'utf8')
  assert.match(parseJourney(v1, 'x') as string, /^format v1/)
})

test('unusable files are refused with a reason; bad parts are dropped', () => {
  assert.match(parseJourney('{', 'x') as string, /not valid JSON/)
  assert.match(parseJourney('[]', 'x') as string, /object/)
  assert.match(parseJourney('{"version":2,"nodes":[],"steps":[]}', 'x') as string, /nodes/)
  assert.match(parseJourney('{"version":2,"nodes":[{"id":"a"}]}', 'x') as string, /steps/)
  const loose = parseJourney(JSON.stringify({
    version: 2,
    nodes: [{ id: 'a', kind: 'system', label: 'A' }, { id: 'b', kind: 'weird', parent: 'nope' }, { id: 'c', parent: 'd' }, { id: 'd', parent: 'c' }, { id: 'a' }],
    edges: [{ from: 'a', to: 'b', label: 'x' }, { from: 'a', to: 'zzz' }, { from: 'a', to: 'a' }],
    steps: [{ node: 'zzz', file: 'f.ts', range: { start: 1 } }, { node: 'b', title: 'T', file: 'f.ts', range: { start: 3, end: 2 }, refs: ['a:1', 'b:2', 'c:3', 'd:4'] }, { node: 'a' }],
  }), 'file-name') as Journey
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
  const many = parseJourney(JSON.stringify({ version: 2, nodes: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, kind: 'system' })), steps: [{ node: 's8', file: 'x', range: { start: 1 } }] }), 'm') as Journey
  assert.equal(many.nodes.length, 9)
  assert.ok(many.problems.some((p) => /top level: 9 boxes/.test(p)))
})

test('step ranges', () => {
  assert.equal(stepRanges([3, 4, 5, 6, 7, 9, 10, 11, 12]), '3–7, 9–12')
  assert.equal(stepRanges([1, 2, 13]), '1, 2, 13')
  assert.equal(stepRanges([8]), '8')
})

test('blurb, path and edge detail are read, and optional', () => {
  const srv = j.nodes.find((n) => n.id === 'backend')!
  assert.equal(srv.blurb, 'HTTP API plus the order worker loop')
  assert.equal(srv.path, 'cmd/shop')
  assert.equal(j.nodes.find((n) => n.id === 'web')!.path, undefined)
  assert.ok(j.edges.some((e) => e.detail === 'validate first, then for real: POST /api/orders'))
  assert.ok(j.edges.every((e) => e.label.length <= 30), 'the map shows the short labels')
  // A journey without blurbs/paths/details still works.
  const bare = parseJourney(JSON.stringify({ ...JSON.parse(fixture), nodes: j.nodes.map(({ blurb, path, ...n }) => n), edges: j.edges.map(({ detail, ...e }) => e) }), 'bare') as Journey
  assert.ok(bare.nodes.every((n) => n.blurb === undefined && n.path === undefined))
  assert.ok(bare.edges.every((e) => e.detail === undefined))
  // Blank values are dropped.
  const blank = parseJourney(JSON.stringify({ version: 2, nodes: [{ id: 'a', blurb: '  ', path: '' }], edges: [], steps: [] }), 'x') as Journey
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
  const k = parseJourney(JSON.stringify({
    version: 2,
    nodes: [{ id: 'srv', kind: 'system', label: 'Server' }, { id: 'rec', kind: 'store', label: 'Record', parent: 'srv' }, { id: 'odd', kind: 'whatever', label: 'Odd' }],
    edges: [{ from: 'odd', to: 'rec', label: 'polls', async: true }],
    steps: [{ node: 'srv', title: 'A', file: 'a.go', range: { start: 1 } }],
  }), 'x') as Journey
  assert.equal(k.nodes.find((n) => n.id === 'rec')!.kind, 'store')
  assert.equal(k.nodes.find((n) => n.id === 'odd')!.kind, 'module', 'an unknown kind is a module')
  assert.equal(k.edges[0].async, true)
})

test('renames come from git, as journey.py check finds them', async () => {
  const { gitRenames } = await import('../src/gitRenames')
  const { execFileSync } = await import('child_process')
  const os = await import('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-git-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  git('init', '-q')
  fs.mkdirSync(path.join(repo, 'web/cart'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'web/cart/basket.ts'), Array.from({ length: 40 }, (_, i) => `line ${i} of basket`).join('\n'))
  fs.writeFileSync(path.join(repo, 'a.go'), Array.from({ length: 40 }, (_, i) => `line ${i} of a`).join('\n'))
  git('add', '.'); git('commit', '-qm', 'one')
  const base = git('rev-parse', '--short', 'HEAD').toString().trim()
  git('mv', 'a.go', 'b.go'); git('commit', '-qm', 'two')
  git('mv', 'web/cart/basket.ts', 'web/cart/cartLines.ts') // staged, not committed
  const m = await gitRenames(repo, base)
  assert.equal(m.get('a.go'), 'b.go', 'a rename committed since the journey\'s commit')
  assert.equal(m.get('web/cart/basket.ts'), 'web/cart/cartLines.ts', 'a staged git mv')
  assert.equal((await gitRenames(path.join(repo, 'nope'))).size, 0, 'no repo: nothing, no error')
  fs.rmSync(repo, { recursive: true, force: true })
})
