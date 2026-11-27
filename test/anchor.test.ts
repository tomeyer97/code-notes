// Full-text anchors (notes, src/core/anchors/anchor.ts), live edits (lineFollow.ts) and the stale diff (staleDiff.ts).
// Compact anchors (journeys, checks) are test/compact.test.ts; both run the scenarios of
// test/fixtures/anchor-scenarios.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchor, AnchorResult } from '../src/core/anchors/anchor'
import { shift } from '../src/core/anchors/lineFollow'
import { lineDiff } from '../src/core/anchors/staleDiff'
import { captureAnchor } from '../src/core/format/noteModel'
import { RANGE, SCENARIOS, WAS } from './anchorScenarios'

/** A note's anchor as stored: its `text`, the lines `before` and `after` it, and `at`: where it is tracked (0-based). */
interface Stored { text: string; before?: string; after?: string; at: { start: number; end: number } }

/** Where the note anchored as `a` is in the lines `now`. */
const anchorIn = (now: string[], a: Stored): AnchorResult => anchor(now, a.text, a.before ?? '', a.after ?? '', a.at)

for (const sc of SCENARIOS) {
  test(`scenario: ${sc.name}`, () => {
    const a = captureAnchor(WAS, RANGE.start, RANGE.end)
    const r = anchorIn(sc.now, { ...a, at: RANGE })
    assert.deepEqual({ ...r.loc, stale: r.stale }, sc.fullText)
  })
}

const file = ['a', 'function f() {', '  return 1', '}', 'b', 'c']

test('unchanged: stays', () => {
  const r = anchorIn(file, { text: 'function f() {\n  return 1', before: 'a', after: '}', at: { start: 1, end: 2 } })
  assert.deepEqual(r, { loc: { start: 1, end: 2 }, stale: false, moved: false })
})

test('lines inserted above (file changed on disk): follows the code', () => {
  const now = ['x', 'y', ...file]
  const r = anchorIn(now, { text: 'function f() {\n  return 1', before: 'a', after: '}', at: { start: 1, end: 2 } })
  assert.deepEqual(r, { loc: { start: 3, end: 4 }, stale: false, moved: true })
})

test('re-indented: still matches', () => {
  const now = ['a', '    function f() {', '        return 1', '    }']
  assert.equal(anchorIn(now, { text: 'function f() {\n  return 1', before: 'a', after: '}', at: { start: 1, end: 2 } }).stale, false)
})

test('code edited: stale at last position', () => {
  const now = ['a', 'function f() {', '  return 2', '}']
  const r = anchorIn(now, { text: 'function f() {\n  return 1', before: 'a', after: '}', at: { start: 1, end: 2 } })
  assert.deepEqual(r, { loc: { start: 1, end: 2 }, stale: true, moved: false })
})

test('code deleted and file shorter: stale, clamped', () => {
  const r = anchorIn(['a'], { text: 'function f() {\n  return 1', before: 'a', after: '}', at: { start: 1, end: 2 } })
  assert.deepEqual(r, { loc: { start: 0, end: 0 }, stale: true, moved: false })
})

test('duplicate text: context decides', () => {
  const now = ['function p() {', 'return 1', '}', 'function a() {', 'return 1', '}']
  const r = anchorIn(now, { text: 'return 1', before: 'function a() {', after: '}', at: { start: 0, end: 0 } })
  assert.equal(r.loc.start, 4)
})

test('shift: insert lines above', () => {
  assert.deepEqual(shift({ start: 5, end: 7 }, { startLine: 1, startChar: 0, endLine: 1, endChar: 0, newLines: 2 }), { start: 7, end: 9 })
})

test('shift: newline at column 0 of the first line pushes the note down', () => {
  assert.deepEqual(shift({ start: 5, end: 7 }, { startLine: 5, startChar: 0, endLine: 5, endChar: 0, newLines: 1 }), { start: 6, end: 8 })
})

test('shift: delete lines inside shrinks', () => {
  assert.deepEqual(shift({ start: 5, end: 9 }, { startLine: 6, startChar: 0, endLine: 8, endChar: 0, newLines: 0 }), { start: 5, end: 7 })
})

test('shift: edit below does nothing', () => {
  assert.deepEqual(shift({ start: 5, end: 7 }, { startLine: 8, startChar: 0, endLine: 9, endChar: 0, newLines: 0 }), { start: 5, end: 7 })
})

test('reformat (quotes, whitespace, trailing semicolon) is not a change', () => {
  const now = ['a', "function f() {", '  return "x"', '}']
  assert.equal(anchorIn(now, { text: "function f() {\n  return 'x';", before: 'a', after: '}', at: { start: 1, end: 2 } }).stale, false)
})

test('deleted code: an identical line in an unrelated place is not a match', () => {
  const before = ['export function a() {', '  return null', '}', 'export function b() {', '  return null', '}']
  // the note was on b()'s "return null"; b() is deleted
  const now = before.slice(0, 3)
  const r = anchorIn(now, { text: '  return null', before: 'export function b() {', after: '}', at: { start: 4, end: 4 } })
  assert.equal(r.stale, true)
})

test('moved code with its context follows', () => {
  const now = ['x', 'y', 'export function b() {', '  return null', '}']
  const r = anchorIn(now, { text: '  return null', before: 'export function b() {', after: '}', at: { start: 0, end: 0 } })
  assert.deepEqual(r, { loc: { start: 3, end: 3 }, stale: false, moved: true })
})

test('substantial unique block moves even without context', () => {
  const block = ['const a = 1', 'const b = 2', 'const c = 3']
  const now = ['other', 'stuff', ...block]
  const r = anchorIn(now, { text: block.join('\n'), before: 'gone', after: 'gone too', at: { start: 0, end: 2 } })
  assert.deepEqual(r.loc, { start: 2, end: 4 })
  assert.equal(r.stale, false)
})

test('blank-line note follows its context', () => {
  const now = ['new', 'new', 'function f() {', '', '}']
  const r = anchorIn(now, { text: '', before: 'function f() {', after: '}', at: { start: 1, end: 1 } })
  assert.deepEqual(r, { loc: { start: 3, end: 3 }, stale: false, moved: true })
})

test('blank-line note whose context is gone is stale', () => {
  const r = anchorIn(['totally', '', 'different'], { text: '', before: 'function f() {', after: '}', at: { start: 1, end: 1 } })
  assert.equal(r.stale, true)
})

test('stale note keeps its size even if live edits stretched it', () => {
  const r = anchorIn(['x', 'y', 'z', 'w', 'v'], { text: 'gone line\nalso gone', before: 'nothing', after: 'here', at: { start: 1, end: 4 } })
  assert.deepEqual(r, { loc: { start: 1, end: 2 }, stale: true, moved: false })
})

test('undo restores the note to the original, not an identical copy', () => {
  const now = ['function copy() {', '  doThing()', '}', 'function original() {', '  doThing()', '}']
  // tracked sits on the copy (the original was deleted, then restored)
  const r = anchorIn(now, { text: '  doThing()', before: 'function original() {', after: '}', at: { start: 1, end: 1 } })
  assert.equal(r.loc.start, 4)
})

test('a long unique line that moved on its own (import sort) follows it', () => {
  const imp = "import { buildLocator, targetSchema } from './locator.js'"
  const now = [imp, "import { a } from './a.js'", "import { b } from './b.js'", "import { probe } from './probe.js'"]
  const r = anchorIn(now, {
    text: imp,
    before: "import { a } from './a.js'\nimport { b } from './b.js'",
    after: "import { probe } from './probe.js'",
    at: { start: 3, end: 3 },
  })
  assert.deepEqual(r.loc, { start: 0, end: 0 })
  assert.equal(r.stale, false)
})

test('a short line found elsewhere without its context: still stale', () => {
  const now = ['x', 'return null', 'y', 'z']
  assert.equal(anchorIn(now, { text: 'return null', before: 'a', after: 'b', at: { start: 3, end: 3 } }).stale, true)
})

test('edited code: stale, on the lines it is about now, not shifted by a line inserted above', () => {
  const was = ['func loop() {', '  interval := cfg.Interval', '  if interval <= 0 {', '    interval = 2 * time.Second', '  }']
  const file = ['package x', '', ...was, 'func other() {}']
  const now = ['package x', '// loop runs one phase', '', 'func loop() {', '  interval := cfg.Interval', '  if interval <= 0 {', '    interval = 5 * time.Second', '  }', 'func other() {}']
  const r = anchorIn(now, { text: was.join('\n'), before: file.slice(0, 2).join('\n'), after: 'func other() {}', at: { start: 2, end: 6 } })
  assert.equal(r.stale, true)
  assert.deepEqual(r.loc, { start: 3, end: 7 })
})

test('lineDiff: only the lines that changed', () => {
  const a = ['a', 'b', 'c = 2', 'd']
  const b = ['// new', 'a', 'b', 'c = 5', 'd']
  assert.deepEqual(lineDiff(a, b), { del: ['c = 2'], ins: ['// new', 'c = 5'] })
})

test('a note on blank lines tracked past the end of a file that shrank: no throw, stale inside the file', () => {
  const r = anchorIn(['const a = 1', 'const b = 2'], { text: '', before: 'function f() {', after: 'return value', at: { start: 8, end: 8 } })
  assert.deepEqual(r, { loc: { start: 1, end: 1 }, stale: true, moved: false })
})
