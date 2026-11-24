// journey.py's checks with node (journey-check.mjs: the extension's rules for shapes, scenes and anchors) and without
// (journey.py's own copy, the fallback): the same answers, word for word, on the same input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { both } from './journeyRules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
const sample = read('test/journey-scene/sample.json')
const shop = read('examples/shop/journeys/place-order.json')
/** Issues in a stable order (a set's order differs between runs in Python). */
const sorted = (issues) => issues.map((i) => i.join(' | ')).sort()

const code = { file: 'src/a.js', line: 3 }
const beats = (...more) => [{ focus: 'a', caption: 'One.', code }, { focus: 'a', caption: 'Two.', code }, { focus: 'a', caption: 'Three.', code }, ...more]
const scene = (actors, more = {}) => ({ actors, wires: [], beats: beats(), ...more })
const BROKEN = {
  'not an object': [],
  'no beats': { actors: [{ id: 'a', type: 'service' }], beats: [] },
  'extra keys, an unknown type, a duplicate id, "all"': { actors: [{ id: 'a', type: 'robot' }, { id: 'a', type: 'service', zoom: 2 }, { id: 'all', type: 'file' }], beats: beats(), extra: 1 },
  'too long everywhere': scene([
    { id: 'a', type: 'service', label: 'A very long service label that goes on', sub: 'and on', fn: 'aFunctionNameThatIsFarTooLong()', checks: ['1', '2', '3', '4', '5', 'a check that is much too long to fit'] },
    { id: 't', type: 'table', rows: [{ id: 'order_7f3a9c2e1b', chips: ['paid', 'shipped', 'refunded', 'held'] }, { id: 'x' }, 'row', { id: 'y' }] },
    { id: 'c', type: 'cluster', pods: [{ label: 'api-7f3a9c' }, { label: 'api-1b2c3d', note: 'a long note under the pod' }, { label: 'api-9e8d7c' }, 5], inner: { label: 'inner', pods: [{ label: 'x'.repeat(40) }] } },
    { id: 'b', type: 'browser', url: 'https://shop.example.com/a/very/long/path', title: 'A shop with a long name', cart: 'Cart 12 items', products: [['A product name too long', '9 €'], 'Fine'] },
  ]),
  'the app window': scene([{
    id: 'a', type: 'console', brand: 'An application with a long brand', logo: 'XYZ', tabs: ['Overview', 'Settings', 'Reports'], screen: 'nowhere',
    dialog: { title: 'Run the whole suite again now', lines: [['Environment!', 'staging-eu-west-1-long'], ['x']], odd: 1, tab: 'Elsewhere' },
    detail: { title: 'Checkout regression', status: 'Investigating', tone: 'grim', cards: [{ title: 'a' }, { title: 'b' }, 'c'], timeline: ['x'.repeat(40)], chat: [{ from: 'bot', text: 'hi' }] },
    signin: { notice: 'n'.repeat(41) },
    pages: { run: { title: 'Runs', chip: 'x'.repeat(20), tone: 'odd', rows: [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['i']], banner: 'b', button: 'Go' }, dialog: {} },
  }]),
  'a beat\'s set and focus': {
    actors: [{ id: 'a', type: 'terminal', lines: ['$ npm test', 'x'.repeat(40)] }, { id: 'f', type: 'file', from: 0, lines: ['one', 'two'] }, { id: 'q', type: 'queue', slots: 4 }, { id: 'g', type: 'gauge', max: 0 }, { id: 'h', type: 'chat', messages: [{ from: 'me', text: 'hi' }, { from: 'x' }, { from: 'them', text: 'y'.repeat(33), tool: true }] }],
    wires: [['a', 'f'], ['a', 'nope'], 'x'],
    beats: [
      { focus: 'a', caption: 'c'.repeat(80), set: { a: { hi: 5, show: 9, zoom: 1 }, f: { hi: [1, 0], text: { 7: 'x', 0: 'y'.repeat(40) } }, nope: {}, q: { fill: 9, note: 'n'.repeat(50) } }, packet: { from: 'a', to: 'q', label: 'p' }, click: 'a' },
      { focus: 'all', caption: 'Two.', muted: 'm'.repeat(60), set: { g: { used: -1, want: 'x' }, h: { hi: 3 } }, flash: 'a' },
      { focus: 'h', caption: '', code: { file: 3 } },
      { focus: 'zzz', caption: 'Four.', hold: 1, odd: true },
      { focus: 'a', caption: 'Five.', packet: { from: 'a', to: 'f', label: 'a packet label that is too long' } },
      { focus: 'a', caption: 'Six.', set: 'x' }, { focus: 'a', caption: 'Seven.' }, 'eight',
    ],
  },
  'a cluster, a table and an app set': {
    actors: [{ id: 'c', type: 'cluster', pods: [{ label: 'a' }], inner: { pods: [{ label: 'b' }] } }, { id: 't', type: 'table', rows: [{ id: 'r', chips: [] }] }, { id: 'p', type: 'app', pages: { runs: { rows: [['a', 'b']] } }, detail: { cards: [{ title: 'c' }] } }, { id: 'c2', type: 'cluster', pods: [] }, { id: 'b', type: 'browser' }],
    beats: beats({ focus: 'c', caption: 'Four.', set: { c: { mark: 3, made: [0, 7], innerGone: [4], innerMark: 1 }, c2: { inner: true }, t: { hi: 2, chips: { 0: ['a'.repeat(60)], 4: [] } }, p: { screen: 'runs', pane: 'nope', rows: 3, hiRow: 1, cards: 2, newCard: 5, chat: 1, typing: 't'.repeat(40), picture: 'p'.repeat(40), status: 's'.repeat(13), tone: 'x' }, b: { lock: 'maybe' } } }),
  },
}

test('scenes: the same issues with node and without, for every scene of the sample and the example, and broken ones', () => {
  const scenes = [...sample.steps, ...shop.steps].filter((s) => s.scene).map((s) => s.scene)
  const requests = [...scenes, ...Object.values(BROKEN)].map((sc, i) => ({ op: 'scene', step: i + 1, scene: sc }))
  const { node, python } = both(requests)
  requests.forEach((_, i) => assert.deepEqual(sorted(node[i]), sorted(python[i]), i < scenes.length ? `scene ${i + 1}` : Object.keys(BROKEN)[i - scenes.length]))
  const said = new Set(node.flat().map(([level, text]) => `${level}: ${text.replace(/^step \d+ scene: /, '')}`))
  for (const words of [
    'problem: actor a: fn "aFunctionNameThatIsFarTooLong()" is 31 chars (max 28: the name and "()")',
    'refuse: actor a: zoom is not read by a service (it reads checks, fn): the engine ignores it',
    "problem: actor a: type 'robot' does not exist (types: app, service, table, cluster, browser, terminal, file, chat, queue, gauge): the engine skips it",
    "problem: actor t: row \"order_7f3a9c2e1b\" with chips ['paid', 'shipped', 'refunded', 'held'] is about 375 px wide (the row holds 300): a shorter id or fewer, shorter chips",
    "problem: actor a: brand \"An application with a long brand\" and tabs ['Overview', 'Settings', 'Reports'] are about 474 px in the top bar (280 fit): shorter names or fewer tabs",
    'warning: actor a: 3 cards; the detail page draws the first 2',
    "refuse: beat 4: set.t: chips ['" + 'a'.repeat(60) + "'] make row 0 wider than the box (300 px)",
    'refuse: beat 1: set.f: hi [1, 0] is a line index or [first, last] of its 2 lines',
  ]) assert.ok(said.has(words), words)
  // The sample's beats have no code lines (it is played without a repository); nothing else is wrong with them.
  const problems = scenes.flatMap((_, i) => node[i]).filter(([level, text]) => level === 'problem' && !text.endsWith('no beat has a code line: a scene lights the code that does what it shows'))
  assert.deepEqual(problems, [], 'the sample and the example draw as they are')
})

test('shapes: the same problems and the same hand-edits read anyway, with node and without', () => {
  const broken = [
    { title: 3, nodes: {}, edges: [], steps: [], question: 1 },
    {
      title: 'T', nodes: [{ id: 'a', kind: 'box', label: 1, at: 'src/a.js:1-2' }, { id: 'b', kind: 'module', label: 'B', at: 'not a range' }, { id: 'c', kind: 'function', label: 'C', at: { file: 'x', start: 1, end: 2 } }, { id: 'd', kind: 'function', label: 'D', at: { file: 'x', start: '1' } }, 'e', { id: 'f', kind: 'store', label: 'F', blurb: 2 }],
      edges: [{ from: 'a', to: 'b', label: 'l', detail: 1 }, { from: 'a' }],
      steps: [{ title: 'S', node: 'c', file: 'x', range: { start: 1, end: 2 }, links: [{ phrase: 'p' }], values: 'v', scene: {}, refs: [1] }, { title: 'S', node: 'c', file: 'x', range: 'x:1-2', lead: 3 }, 'step'],
    },
  ]
  const requests = [sample, shop, ...broken].map((journey) => ({ op: 'shape', journey }))
  const { node, python } = both(requests)
  assert.deepEqual(node, python)
  assert.deepEqual(node[1], { problems: [], upgrades: [] }, 'the example reads as it is')
  assert.equal(node[0].upgrades.length, sample.steps.length, 'the sample has no anchors: each step gets one')
  assert.ok(node[3].problems.includes("box a: kind 'box' is not one of system, module, function, external, store"))
  assert.deepEqual(node[3].upgrades.map((u) => u.node ?? `step ${u.step}`), [0, 2, 'step 0'])
})

test('anchors: every relocation case of the extension is found in the same place with node and without', () => {
  const cases = read('test/fixtures/compact-cases.json')
  const { node, python } = both(cases.map((c) => ({ op: 'place', ...c })))
  cases.forEach((c, i) => {
    const want = c.expected.state === 'gone' ? null : [c.expected.start, c.expected.end, c.expected.state === 'fresh']
    assert.deepEqual(node[i], want, `node: ${c.name}`)
    assert.deepEqual(python[i], want, `python: ${c.name}`)
  })
})

test('lines: a link\'s or a beat\'s line is found again by its text, the nearest first, up to 400 lines away', () => {
  const lines = ['a', '  b', 'c', 'b', ...Array(400).fill('x'), 'far']
  const requests = [[2, 'b'], [3, 'b'], [4, ' b '], [1, 'far'], [404, 'far'], [1, ''], [9, 'gone']].map(([line, text]) => ({ op: 'line', lines, line, text }))
  const { node, python } = both(requests)
  assert.deepEqual(node, [1, 1, 3, -1, 404, -1, -1])
  assert.deepEqual(python, node)
})

test('limits: journey.py\'s own scene limits are the journey schema\'s', () => {
  const defs = read('src/core/format/schema/journey.schema.json').$defs
  const names = ['LABEL_CHARS', 'FN_CHARS', 'MAX_CHECKS', 'MAX_CHECK', 'MAX_ROWS', 'MAX_ACTORS', 'MAX_BEATS', 'MIN_BEATS', 'MAX_TERM_LINE', 'FILE_CHARS', 'CHAT_CHARS', 'NOTE_CHARS', 'TAB_CHARS', 'MAX_TABS', 'BROWSER_CHARS', 'DIALOG_CHARS', 'DETAIL_CHARS', 'SIGNIN_CHARS', 'ACTOR_KEYS', 'SET_KEYS', 'BEAT_KEYS', 'COMMON_KEYS']
  const [py] = both([{ op: 'limits', names }]).python
  const prop = (def, ...p) => p.reduce((s, k) => (k === '[]' ? s.items : s.properties[k]), defs[def])
  for (const [t, n] of Object.entries(py.LABEL_CHARS)) assert.equal(n, prop(`actor.${t}`, 'label').maxLength, `${t} label`)
  assert.equal(py.FN_CHARS, prop('actor.service', 'fn').maxLength)
  assert.equal(py.MAX_CHECKS, prop('actor.service', 'checks').maxItems)
  assert.equal(py.MAX_CHECK, prop('actor.service', 'checks', '[]').maxLength)
  assert.equal(py.MAX_ROWS, prop('actor.table', 'rows').maxItems)
  assert.equal(py.MAX_ACTORS, defs.scene.properties.actors.maxItems)
  assert.deepEqual([py.MIN_BEATS, py.MAX_BEATS], [defs.scene.properties.beats.minItems, defs.scene.properties.beats.maxItems])
  assert.equal(py.MAX_TERM_LINE, prop('actor.terminal', 'lines', '[]').maxLength)
  assert.equal(py.FILE_CHARS, prop('actor.file', 'lines', '[]').maxLength)
  assert.equal(py.CHAT_CHARS, prop('actor.chat', 'messages', '[]', 'text').maxLength)
  assert.equal(py.NOTE_CHARS, prop('actor.queue', 'cap').maxLength)
  assert.deepEqual([py.TAB_CHARS, py.MAX_TABS], [prop('actor.app', 'tabs', '[]').maxLength, prop('actor.app', 'tabs').maxItems])
  for (const [k, n] of Object.entries(py.BROWSER_CHARS)) assert.equal(n, prop('actor.browser', k).maxLength, `browser ${k}`)
  for (const [screen, table] of [['dialog', py.DIALOG_CHARS], ['detail', py.DETAIL_CHARS], ['signin', py.SIGNIN_CHARS]]) {
    for (const [k, n] of Object.entries(table)) assert.equal(n, prop('actor.app', screen, k).maxLength, `${screen} ${k}`)
  }
  const keys = (def) => Object.keys(defs[def].properties).sort()
  for (const [t, ks] of Object.entries(py.ACTOR_KEYS)) assert.deepEqual([...ks, ...py.COMMON_KEYS].sort(), keys(`actor.${t}`), `${t} reads`)
  for (const [t, ks] of Object.entries(py.SET_KEYS)) assert.deepEqual([...ks].sort(), keys(`setState.${t}`), `${t} set`)
  assert.deepEqual([...py.BEAT_KEYS].sort(), keys('beat'))
})
