import test from 'node:test'
import assert from 'node:assert/strict'
import { capValue, findLine, followLine, shiftLine } from '../src/beatLine'

test('findLine: the written line, the nearest moved one, or gone', () => {
  const lines = ['a()', '  store(run)', 'b()', '  store(run)', 'c()']
  assert.equal(findLine(lines, 2, 'store(run)'), 1)
  assert.equal(findLine(lines, 5, 'store(run)'), 3) // moved: the nearest line that still says so
  assert.equal(findLine(lines, 3, 'gone()'), -1)
  assert.equal(findLine(lines, 3, '  '), -1)
})

test('shiftLine / followLine: hints, links and the lit beat follow edits above them', () => {
  // two lines inserted above line 5 (0-based), one removed above it
  assert.equal(shiftLine(5, [{ start: 1, end: 1, text: 'x\ny\n' }]), 7)
  assert.equal(shiftLine(5, [{ start: 1, end: 2, text: '' }]), 4)
  assert.equal(shiftLine(5, [{ start: 5, end: 5, text: 'a\n' }]), 5, 'an edit on the line itself does not move it')
  assert.equal(shiftLine(5, [{ start: 8, end: 8, text: 'a\n' }]), 5, 'below: no move')
  const lines = ['new', 'new', 'a()', '  store(run)', 'b()']
  assert.equal(followLine(lines, 1, 'store(run)', [{ start: 0, end: 0, text: 'new\nnew\n' }]), 3)
  assert.equal(followLine(lines, 1, 'gone()', [{ start: 0, end: 0, text: 'new\nnew\n' }]), -1)
  assert.equal(followLine(lines, 1, '', [{ start: 0, end: 0, text: 'new\nnew\n' }]), 3, 'no text: shifted')
})

test('capValue: about 40 characters, the note survives', () => {
  assert.equal(capValue('short'), 'short')
  const long = 'x'.repeat(60)
  assert.equal(capValue(long).length, 40)
  assert.ok(capValue(long).endsWith('…'))
})
