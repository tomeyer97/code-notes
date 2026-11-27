// The references step text links (src/journeys/textFormat.ts REF_IN_TEXT): a table of what links and what doesn't.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REF_IN_TEXT, linkPaths } from '../src/journeys/textFormat'

/** Each text, and the references in it: [path, first line]. */
const TABLE: [string, [string, number][]][] = [
  ['api/orders.go:12', [['api/orders.go', 12]]],
  ['`web/src/a.ts:3-5`', [['web/src/a.ts', 3]]],
  ['web/src/a.ts:3–5 (en dash)', [['web/src/a.ts', 3]]],
  ['(worker/w.go#L9)', [['worker/w.go', 9]]],
  ['two: a/b.ts:1 and c/d.ts:2', [['a/b.ts', 1], ['c/d.ts', 2]]],
  // Not linked: no folder, no line, already a link, inside a longer path or word.
  ['orders.go:12', []],
  ['api/orders.go', []],
  ['[x](api/orders.go:3)', []],
  ['[api/orders.go:3](x)', []],
  ['x/api/orders.go:3', [['x/api/orders.go', 3]]],
  ['~/api/orders.go:3', []],
  ['word/api/orders.go:3', [['word/api/orders.go', 3]]],
  ['./x/y.js:3', [['./x/y.js', 3]]],
  // An extension of letters only (1-6): these don't link today.
  ['media/song.mp3:1', []],
  ['build/Makefile:3', []],
]

test('REF_IN_TEXT: the references that link (named groups: path, line or hashLine), and those that don\'t', () => {
  for (const [text, want] of TABLE) {
    const got = [...text.matchAll(REF_IN_TEXT)].map((m) => [m.groups!.path, Number(m.groups!.line ?? m.groups!.hashLine)])
    assert.deepEqual(got, want, text)
  }
})

test('REF_IN_TEXT: the groups are also numbered path, line, hashLine (tour/stepText.ts reads them so)', () => {
  const m = [...'a/b.ts#L4 and c/d.ts:5'.matchAll(REF_IN_TEXT)]
  assert.deepEqual(m.map((x) => [x[1], x[2], x[3]]), [['a/b.ts', undefined, '4'], ['c/d.ts', '5', undefined]])
})

test('linkPaths: each reference made a link from its text without backticks, the file and the first line', () => {
  const link = (text: string, file: string, line: number) => `{${text}|${file}|${line}}`
  assert.equal(linkPaths('See `api/a.ts:3-4` and b/c.go#L7.', link), 'See {api/a.ts:3-4|api/a.ts|3} and {b/c.go#L7|b/c.go|7}.')
})
