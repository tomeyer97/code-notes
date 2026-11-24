// Where things are in a JSON text (src/core/json/spans.ts): the value at a path, where invalid JSON stops, line and
// column. Every case of its use by the podcast check is in test/goldens/podcast/helpers.json too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSyntaxError, lineCol, locate } from '../src/core/json/spans'

const text = '{\n  "a": [1, {"x": 2}],\n  "b": "s"\n}'
const at = (path: (string | number)[]) => { const s = locate(text, path); return text.slice(s.start, s.end) }

test('json spans: a key\'s value spans from its key; an item is itself; a path partly there is its deepest part', () => {
  assert.equal(at(['a']), '"a": [1, {"x": 2}]')
  assert.equal(at(['a', 1, 'x']), '"x": 2')
  assert.equal(at(['a', 0]), '1')
  assert.equal(at(['a', 5]), '"a": [1, {"x": 2}]')
  assert.equal(at([]), text)
})

test('json spans: invalid JSON is said with its line and column; locate points at the place', () => {
  assert.equal(jsonSyntaxError(text), undefined)
  assert.equal(jsonSyntaxError('{\n  "a": }'), 'line 2, column 8: unexpected "}"')
  assert.equal(jsonSyntaxError('[1, 2'), 'line 1, column 6: the file ends too early (cut off?)')
  assert.equal(jsonSyntaxError('{"a" 1}'), 'line 1, column 6: expected ":", found "1"')
  assert.equal(jsonSyntaxError('[1 2]'), 'line 1, column 4: expected "," or "]", found "2"')
  assert.deepEqual(locate('{\n  "a": }', ['a']), { start: 9, end: 10 })
  assert.deepEqual(lineCol('ab\ncd', 4), { line: 1, col: 1 })
})
