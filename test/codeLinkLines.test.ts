import test from 'node:test'
import assert from 'node:assert/strict'
import { lineChanged, locateStepLine, sameLinks, sameValues } from '../src/codeLinks/lines'
import { Latest } from '../src/codeLinks/latest'

const LINES = ['a()', 'b()', 'c()', 'd()']

test('locateStepLine: found by its text near the written line; no text: as written, or gone', () => {
  assert.equal(locateStepLine(LINES, { line: 2, text: 'b()' }), 1, 'where written')
  assert.equal(locateStepLine(LINES, { line: 1, text: '  c()  ' }), 2, 'moved down, found by its text')
  assert.equal(locateStepLine(LINES, { line: 2, text: 'e()' }), -1, 'its text is gone')
  assert.equal(locateStepLine(LINES, { line: 3, text: ' ' }), 2, 'no text: the line as written')
  assert.equal(locateStepLine(LINES, { line: 9, text: '' }), 3, 'no text, past the end: the last line')
  assert.equal(locateStepLine(LINES, { line: 3, text: '' }, 'gone'), -1, 'no text, and a line needs one')
})

test('lineChanged: one wording for a step line that is gone', () => {
  assert.equal(lineChanged('value hint body', 'the line at a.ts:3', 'not shown'), 'value hint body: the line at a.ts:3 changed; not shown')
})

test('sameLinks and sameValues: field by field, in order', () => {
  const l = (phrase: string, start = 1) => ({ phrase, file: 'a.ts', start, end: start, text: 'x' })
  assert.ok(sameLinks([l('a'), l('b')], [l('a'), l('b')]))
  assert.ok(!sameLinks([l('a'), l('b')], [l('b'), l('a')]), 'order counts')
  assert.ok(!sameLinks([l('a')], [l('a', 2)]), 'a moved line counts')
  assert.ok(!sameLinks([l('a')], [l('a'), l('b')]))
  const v = (value: string, note?: string) => ({ name: 'n', value, ...(note ? { note } : {}), file: 'a.ts', line: 1, text: 'x' })
  assert.ok(sameValues([v('1')], [v('1')]))
  assert.ok(!sameValues([v('1')], [v('2')]))
  assert.ok(!sameValues([v('1')], [v('1', 'why')]), 'a note added counts')
})

test('Latest: the newest request is current; join does not start one; cancel ends them all', () => {
  const latest = new Latest()
  const a = latest.begin()
  assert.ok(a.current)
  const joined = latest.join()
  assert.ok(a.current && joined.current, 'joining keeps the request in flight current')
  const b = latest.begin()
  assert.ok(!a.current && !joined.current && b.current)
  latest.cancel()
  assert.ok(!b.current)
})
