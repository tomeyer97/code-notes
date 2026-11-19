import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findMark, markCodeProblem, marksIn, readMarks, walkMarks } from '../src/marks/model'

// Marks (src/marks/model.ts): one shape, read and found the same way for a journey's steps and beats and a podcast's
// segments (the podcast's own fields, phrase and at: test/podcastModel.test.ts).

test('found by match within the lines (its nth), re-found within 20 lines when the code moved, else the whole lines', () => {
  const doc = ['package a', '', '\tif n := NeedsModel(steps); g == nil && n > 0 {', '\t\treturn reject(400)', '\t}', '\treturn reject(400)']
  assert.deepEqual(findMark(doc, { lines: [3, 3], match: 'NeedsModel(steps)' }), { spot: { line: 2, col: 9, endLine: 2, endCol: 26 }, moved: 0, found: true })
  // nth counts within the lines; a match may span them.
  assert.deepEqual(findMark(doc, { lines: [4, 6], match: 'reject(400)', nth: 2 })!.spot, { line: 5, col: 8, endLine: 5, endCol: 19 })
  assert.deepEqual(findMark(doc, { lines: [4, 5], match: '400)\n\t}' })!.spot, { line: 3, col: 16, endLine: 4, endCol: 2 })
  // The code moved down 3 lines: the nearest shift that has it.
  const moved = ['//', '//', '//', ...doc]
  assert.deepEqual(findMark(moved, { lines: [3, 3], match: 'g == nil' }), { spot: { line: 5, col: 28, endLine: 5, endCol: 36 }, moved: 3, found: true })
  // Up before down at the same distance; nearer first.
  const both = ['x', 'hit', 'y', 'hit']
  assert.equal(findMark(both, { lines: [3, 3], match: 'hit' })!.moved, -1)
  assert.equal(findMark(Array.from({ length: 30 }, (_, i) => (i === 25 ? 'far' : '-')), { lines: [1, 1], match: 'far' })!.found, false, 'more than 20 lines away: not found')
  // Not there: the whole lines, from the first line's text; no match: the same, found.
  assert.deepEqual(findMark(doc, { lines: [3, 4], match: 'nothing' }), { spot: { line: 2, col: 1, endLine: 3, endCol: 20 }, moved: 0, found: false })
  assert.deepEqual(findMark(doc, { lines: [4, 4] }), { spot: { line: 3, col: 2, endLine: 3, endCol: 20 }, moved: 0, found: true })
  assert.equal(findMark(doc, { lines: [7, 8] }), undefined, 'past the end: nothing')
  assert.deepEqual(findMark(doc, { lines: [6, 9] })!.spot, { line: 5, col: 1, endLine: 5, endCol: 19 }, 'partly past the end: what is there')
})

test('read: the usable marks in order; each bad one left out with what is wrong and where', () => {
  const r = readMarks([
    { lines: [3, 3], match: 'reserve(' },
    { lines: [5, 4] },
    { lines: [2, 2], match: '' },
    { lines: [2, 2], nth: 0, match: 'x' },
    { lines: [7, 9], file: 'src/b.ts', nth: 2, match: 'ok' },
    'x',
    { file: ' ', lines: [1, 1] },
  ])
  assert.deepEqual(r.marks, [{ lines: [3, 3], match: 'reserve(' }, { lines: [7, 9], file: 'src/b.ts', match: 'ok', nth: 2 }])
  assert.deepEqual(r.problems.map((p) => [p.k, p.sub.join('.'), p.drop]), [[1, 'marks.1.lines', true], [2, 'marks.2.match', true], [3, 'marks.3.nth', true], [5, 'marks.5', true], [6, 'marks.6.file', true]])
  assert.match(r.problems[0].what, /^mark 2: lines must be \[first, last\] \(1-based, first <= last\), got \[5,4\]; ignored$/)
  assert.match(r.problems[3].what, /mark 6: not an object/)
  assert.deepEqual(readMarks(undefined), { marks: [], problems: [] }, 'none: nothing to say')
  assert.equal(readMarks({}).problems[0].what, 'marks is not a list of { lines, match? }; ignored')
  assert.deepEqual(marksIn('nope'), [])
})

test('against the code: in place says nothing; moved, missing, past the end, no file each say so (the reader\'s view per owner)', () => {
  const doc = ['a', '  const stock = await db.reserve(cart.items)', '  if (!stock.ok) return reject(409)', 'b']
  assert.equal(markCodeProblem(doc, 'o.ts', { lines: [2, 2], match: 'db.reserve' }, 'drop'), undefined)
  assert.equal(markCodeProblem(doc, 'o.ts', { lines: [2, 3] }, 'drop'), undefined, 'whole lines: nothing to find')
  assert.deepEqual(markCodeProblem(doc, 'o.ts', { lines: [2, 2], match: 'reject(409)' }, 'drop'), { what: '"reject(409)" isn\'t in line 2 of o.ts; found 1 line down, lit there', sub: 'match', moved: 1 })
  assert.equal(markCodeProblem(doc, 'o.ts', { lines: [2, 3], match: 'stock', nth: 3 }, 'drop')!.what, '"stock" (occurrence 3) isn\'t in lines 2–3 of o.ts, nor within 20 lines: nothing is lit')
  assert.match(markCodeProblem(doc, 'o.ts', { lines: [1, 1], match: 'zzz' }, 'lines')!.what, /: the whole lines light$/)
  assert.deepEqual(markCodeProblem(doc, 'o.ts', { lines: [3, 6] }, 'drop'), { what: 'lines 3–6 of o.ts go past its end (4 lines)', sub: 'lines' })
  assert.equal(markCodeProblem(doc, 'o.ts', { lines: [6, 6] }, 'drop')!.what, 'line 6 of o.ts is past its end (4 lines); nothing is lit')
  assert.deepEqual(markCodeProblem(null, 'x.ts', { lines: [1, 1], file: 'x.ts' }, 'drop'), { what: 'x.ts isn\'t in the repository; nothing is lit', sub: 'file' })
})

test('walked: the step\'s marks, then each beat\'s up to the one lit; the newest group with marks is the focus, the rest dim', () => {
  const show = (r: { mark: string; focus: boolean }[]) => r.map((x) => `${x.mark}${x.focus ? '*' : ''}`).join(' ')
  const step = ['s1', 's2'], beats = [['b1'], [], ['c1', 'c2']]
  assert.equal(show(walkMarks(step, beats, undefined)), 's1* s2*', 'no beat: the step\'s own, all the focus')
  assert.equal(show(walkMarks(step, beats, 0)), 's1 s2 b1*', 'beat 1: its marks the focus, the step\'s dim')
  assert.equal(show(walkMarks(step, beats, 1)), 's1 s2 b1*', 'a beat without marks: the newest before it stays the focus')
  assert.equal(show(walkMarks(step, beats, 2)), 's1 s2 b1 c1* c2*')
  assert.equal(show(walkMarks([], beats, 2)), 'b1 c1* c2*')
  assert.equal(show(walkMarks([], [], undefined)), '', 'no marks: nothing')
  assert.deepEqual(walkMarks(step, beats, 9).map((x) => x.group), [-1, -1, 0, 2, 2], 'past the last beat: all of them')
})
