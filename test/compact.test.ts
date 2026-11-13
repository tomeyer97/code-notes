// Compact anchors (v3): relocation as in docs/journey-format.md ("In the repo"), the same rules as journey.py.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockHash, compactOf, findCompact, toCompact } from '../src/compact'
import { parseJourney } from '../src/journeyModel'

const file = [
  'package main',                     // 0
  '',                                 // 1
  'import "fmt"',                     // 2
  '',                                 // 3
  'func create(env string) error {',  // 4
  '  rec := newRecord(env)',          // 5
  '  rec.State = "pending"',          // 6
  '  if err := save(rec); err != nil {', // 7
  '    return err',                   // 8
  '  }',                              // 9
  '  return nil',                     // 10
  '}',                                // 11
  '',                                 // 12
  'func other() {}',                  // 13
]
const a = compactOf(file, 4, 11)!

test('compactOf: head ≤ 3 and tail ≤ 2 non-blank lines, length, 12-hex hash, nearest non-blank before/after', () => {
  assert.equal(a.v, 3)
  assert.equal(a.head, 'func create(env string) error {\n  rec := newRecord(env)\n  rec.State = "pending"')
  assert.equal(a.tail, '  return nil\n}')
  assert.equal(a.lines, 8)
  assert.match(a.hash, /^[0-9a-f]{12}$/)
  assert.equal(a.before, 'import "fmt"')
  assert.equal(a.after, 'func other() {}')
  // The normalized text: whitespace, quote style and blank lines don't change it.
  assert.equal(blockHash(["  x := 'a';", '', 'y']), blockHash(['x := "a"', 'y']))
})

test('unchanged: fresh at its place', () => {
  assert.deepEqual(findCompact(file, a, 4), { state: 'fresh', loc: { start: 4, end: 11 } })
})

test('a moved block: fresh at the new place', () => {
  const moved = [...file.slice(0, 4), '// a comment', 'var x = 1', 'var y = 2', '', ...file.slice(4)]
  assert.deepEqual(findCompact(moved, a, 4), { state: 'fresh', loc: { start: 8, end: 15 } })
  // Moved to after other code entirely.
  const swapped = [...file.slice(0, 4), 'func other() {}', '', ...file.slice(4, 12)]
  assert.deepEqual(findCompact(swapped, a, 4), { state: 'fresh', loc: { start: 6, end: 13 } })
})

test('reformatted (indentation, quotes, blank lines inside): still fresh', () => {
  const ref = [...file.slice(0, 5), '\trec := newRecord(env);', "\trec.State = 'pending'", '', ...file.slice(7)]
  const r = findCompact(ref, a, 4)
  assert.equal(r.state, 'fresh')
})

test('edited inside (head and tail kept): changed, shown at its place', () => {
  const ed = [...file]
  ed[8] = '    return fmt.Errorf("save: %w", err)'
  assert.deepEqual(findCompact(ed, a, 4), { state: 'changed', loc: { start: 4, end: 11 } })
  // Lines added inside, within the length window: changed, with its new end.
  const grown = [...file.slice(0, 10), '  log("saved")', '  metrics.Inc()', ...file.slice(10)]
  assert.deepEqual(findCompact(grown, a, 4), { state: 'changed', loc: { start: 4, end: 13 } })
})

test('deleted, or its head or tail gone: gone', () => {
  assert.deepEqual(findCompact([...file.slice(0, 4), ...file.slice(12)], a, 4), { state: 'gone' })
  const headEdited = [...file]
  headEdited[4] = 'func create(env string, opts Options) error {'
  assert.deepEqual(findCompact(headEdited, a, 4), { state: 'gone' })
  // Grown past lines·1.5 + 5: not the same block any more.
  const huge = [...file.slice(0, 10), ...Array.from({ length: 20 }, (_, i) => `  step${i}()`), ...file.slice(10)]
  assert.deepEqual(findCompact(huge, a, 4), { state: 'gone' })
})

test('duplicates: the exact hash first, then the line count, then before/after context, then nearness', () => {
  const block = ['if err != nil {', '  return err', '}']
  const lines = ['a := load()', ...block, 'b := next()', '', 'c := other()', ...block, 'd := last()']
  const second = compactOf(lines, 7, 9)!
  // Same code twice, same length: the context (c := other() above) picks the second, wherever the hint is.
  assert.deepEqual(findCompact(lines, second, 0), { state: 'fresh', loc: { start: 7, end: 9 } })
  const first = compactOf(lines, 1, 3)!
  assert.deepEqual(findCompact(lines, first, 9), { state: 'fresh', loc: { start: 1, end: 3 } })
  // No context to go by: the one nearest to where it was.
  const bare = { ...first, before: '', after: '' }
  assert.deepEqual(findCompact(lines, bare, 8), { state: 'fresh', loc: { start: 7, end: 9 } })
  // The exact hash beats context: one copy edited inside (same head and tail).
  const body = ['func f() {', '  one()', '  two()', '}']
  const ls2 = ['x()', ...body, '', 'y()', 'func f() {', '  one()', '  CHANGED()', '}']
  const orig = { ...compactOf(ls2, 1, 4)!, before: 'y()' }   // context says the second copy; the hash says the first
  assert.deepEqual(findCompact(ls2, orig, 7), { state: 'fresh', loc: { start: 1, end: 4 } })
})

test('a stored range ending in blank lines stays fresh at its stored length', () => {
  const lines = ['x()', 'func g() {', '  h()', '}', '', '', 'z()']
  const c = compactOf(lines, 1, 5)!
  assert.equal(c.lines, 5)
  assert.deepEqual(findCompact(lines, c, 1), { state: 'fresh', loc: { start: 1, end: 5 } })
})

test('v2 full-text anchors are read as v3 in memory', () => {
  const v2 = { text: file.slice(4, 12).join('\n'), before: 'import "fmt"\n', after: '\nfunc other() {}' }
  const c = toCompact(v2)!
  assert.deepEqual({ ...c }, { ...a })
  assert.equal(findCompact(file, c, 4).state, 'fresh')
  assert.equal(toCompact({ text: '\n\n', before: 'a', after: 'b' }), undefined, 'a step on blank lines keeps the context-only path')
})

test('parseJourney reads v3 anchors on steps and boxes (files v2 or v3); v2 anchors still read', () => {
  const j = parseJourney(JSON.stringify({
    version: 3, id: 'x', question: 'q', title: 't', summary: '',
    nodes: [{ id: 'm', kind: 'module', label: 'M', summary: '' }, { id: 'f', kind: 'function', label: 'F', parent: 'm', summary: '', at: { file: 'a.go', start: 5, end: 12, anchor: a } }],
    edges: [],
    steps: [
      { id: 's1', title: 'one', node: 'f', file: 'a.go', range: { start: 5, end: 12 }, anchor: a, lead: '' },
      { id: 's2', title: 'two', node: 'f', file: 'a.go', range: { start: 6, end: 6 }, anchor: { text: 'x', before: '', after: '' }, lead: '' },
      { id: 's3', title: 'three', node: 'f', file: 'a.go', range: { start: 6, end: 6 }, anchor: { v: 3, head: '' }, lead: '' },
    ],
  }), 'x')
  assert.ok(typeof j === 'object')
  assert.deepEqual(j.steps[0].anchor, a)
  assert.deepEqual(j.steps[1].anchor, { text: 'x', before: '', after: '' })
  assert.equal(j.steps[2].anchor, undefined, 'a v3 anchor without a head is dropped (taken from the code instead)')
  assert.deepEqual(j.nodes[1].at?.anchor, a)
})
