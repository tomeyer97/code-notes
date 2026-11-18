import test from 'node:test'
import assert from 'node:assert/strict'
import { LineEdit, findLine, followLine, shiftLine } from '../src/lineFollow'

test('findLine: the written line, the nearest moved one, or gone', () => {
  const lines = ['a()', '  store(run)', 'b()', '  store(run)', 'c()']
  assert.equal(findLine(lines, 2, 'store(run)'), 1)
  assert.equal(findLine(lines, 5, 'store(run)'), 3) // moved: the nearest line that still says so
  assert.equal(findLine(lines, 3, 'gone()'), -1)
  assert.equal(findLine(lines, 3, '  '), -1)
})

/** Lines start..end replaced by `text`. */
const edit = (start: number, end: number, text: string): LineEdit =>
  ({ startLine: start, startChar: 0, endLine: end, endChar: 0, newLines: text.split('\n').length - 1 })

test('shiftLine / followLine: hints, links and the lit beat follow edits above them', () => {
  // two lines inserted above line 5 (0-based), one removed above it
  assert.equal(shiftLine(5, [edit(1, 1, 'x\ny\n')]), 7)
  assert.equal(shiftLine(5, [edit(1, 2, '')]), 4)
  assert.equal(shiftLine(5, [edit(5, 5, 'a\n')]), 5, 'an edit on the line itself does not move it')
  assert.equal(shiftLine(5, [edit(8, 8, 'a\n')]), 5, 'below: no move')
  const lines = ['new', 'new', 'a()', '  store(run)', 'b()']
  assert.equal(followLine(lines, 1, 'store(run)', [edit(0, 0, 'new\nnew\n')]), 3)
  assert.equal(followLine(lines, 1, 'gone()', [edit(0, 0, 'new\nnew\n')]), -1)
  assert.equal(followLine(lines, 1, '', [edit(0, 0, 'new\nnew\n')]), 3, 'no text: shifted')
})
