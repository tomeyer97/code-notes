// Where a journey's steps are (src/journeys/steps.ts): carried over a reload, captured anchors, placed in new lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJourney, Journey } from '../src/journeyModel'
import { compactOf } from '../src/compact'
import { LoadedJourney, StepAt, captureStepAnchor, carryPositions, fileOf, isEmptyAnchor, journeyById, placeStep, posKey, sameStepAt, writtenAt } from '../src/journeys/steps'
import { dirPath, pathIn } from '../src/paths'

const code = ['import x', '', 'function f() {', '  a()', '  x()', '  y()', '  b()', '}', '', 'function g() {}']
const journey = (steps: object[]) => parseJourney(JSON.stringify({ version: 2, nodes: [{ id: 'n', label: 'N' }], steps }), 'j') as Journey
const step = (o: object = {}) => ({ id: 's1', node: 'n', file: 'src/a.ts', range: { start: 3, end: 8 }, title: 'f', ...o })
const loaded = (j: Journey, at?: StepAt[]): LoadedJourney =>
  ({ key: 'k', folder: { uri: { path: '/w', toString: () => 'file:///w' } }, uri: {}, j, at: at ?? writtenAt(j) }) as unknown as LoadedJourney

test('pathIn / dirPath: a path inside a folder, never one that only starts with its name', () => {
  assert.equal(dirPath({ path: '/w' }), '/w/')
  assert.equal(dirPath({ path: '/w/' }), '/w/')
  assert.equal(pathIn({ path: '/w' }, { path: '/w/src/a.ts' }), 'src/a.ts')
  assert.equal(pathIn({ path: '/w' }, { path: '/w2/a.ts' }), undefined)
})

test('fileOf: the step\'s file, or where it was renamed to', () => {
  const lj = loaded(journey([step()]))
  assert.equal(fileOf(lj, 1), 'src/a.ts')
  lj.at[0] = { ...lj.at[0], file: 'src/b.ts' }
  assert.equal(fileOf(lj, 1), 'src/b.ts')
})

test('posKey: the journey\'s folder and id (the same id in two folders is two journeys)', () => {
  const lj = loaded(journey([step()]))
  assert.equal(posKey(lj), `file:///w|${lj.j.id}`)
  const other = { ...lj, folder: { uri: { toString: () => 'file:///v' } } } as unknown as LoadedJourney
  assert.notEqual(posKey(other), posKey(lj))
})

test('carryPositions: the same steps keep where they were found; a changed step starts over', () => {
  const prev = loaded(journey([step(), step({ id: 's2', range: { start: 8, end: 8 } })]))
  prev.at = [{ start: 13, end: 18, stale: false }, { start: 20, end: 20, stale: true }]
  const next = loaded(journey([step({ id: 's2', range: { start: 9, end: 9 } }), step({ title: 'renamed title' })]))
  carryPositions(prev, next)
  assert.deepEqual(next.at, [{ start: 9, end: 9, stale: false }, { start: 13, end: 18, stale: false }], 's2 moved in the file: not carried; s1 only retitled: carried')
})

test('sameStepAt: what the reader sees, not the diff\'s old side', () => {
  const a: StepAt = { start: 1, end: 2, stale: true, now: 'x', was: 'a' }
  assert.ok(sameStepAt(a, { ...a, was: 'b' }))
  for (const k of ['start', 'end', 'stale', 'removed', 'now', 'file'] as const) assert.ok(!sameStepAt(a, { ...a, [k]: 99 }), k)
})

test('captureStepAnchor (a step\'s, compact; noteModel.ts\'s captureAnchor keeps the full text): compact from the written range; a step on blank lines keeps its context', () => {
  assert.deepEqual(captureStepAnchor(code, { start: 3, end: 8 }), compactOf(code, 2, 7))
  assert.deepEqual(captureStepAnchor(code, { start: 9, end: 9 }), { text: '', before: '  b()\n}', after: 'function g() {}' })
  assert.deepEqual(captureStepAnchor(code, { start: 40, end: 50 }), compactOf(code, 9, 9), 'past the end: the last line')
  assert.ok(isEmptyAnchor(undefined) && isEmptyAnchor({ text: '', before: '', after: '' }))
  assert.ok(!isEmptyAnchor({ text: '', before: 'x', after: '' }) && !isEmptyAnchor(compactOf(code, 0, 0)))
})

test('placeStep: fresh where its code moved, changed with a diff, removed when gone', () => {
  const a = compactOf(code, 2, 7)!
  const was: StepAt = { start: 3, end: 8, stale: false }
  assert.deepEqual(placeStep(['// new', ...code], a, was, {}), { start: 4, end: 9, stale: false })
  const edited = [...code.slice(0, 5), '  z()', ...code.slice(6)]
  assert.deepEqual(placeStep(edited, a, was, { file: 'src/b.ts' }), { start: 3, end: 8, stale: true, file: 'src/b.ts', was: '', now: edited.slice(2, 8).join('\n') })
  assert.deepEqual(placeStep(['other'], a, was, {}), { start: 1, end: 1, stale: true, removed: true })
})

test('placeStep: a step on blank lines stays put, never moves to look-alike blank lines', () => {
  const blankStep = { text: '', before: '  b()\n}', after: 'function g() {}' }
  const was: StepAt = { start: 9, end: 9, stale: false }
  assert.deepEqual(placeStep(code, blankStep, was, {}), { start: 9, end: 9, stale: false })
  assert.deepEqual(placeStep(['x', ...code], blankStep, was, {}), { ...was, stale: true }, 'found elsewhere: stale where it was')
})

test('journeyById: the journey with that id in the folder asked for, else the first with that id', () => {
  const inFolder = (folder: string, id: string) => ({ folder: { uri: { toString: () => folder } }, j: { id } })
  const a = inFolder('file:///a', 'demo'), b = inFolder('file:///b', 'demo'), c = inFolder('file:///b', 'other')
  assert.equal(journeyById([a, b, c], 'demo', 'file:///b'), b)
  assert.equal(journeyById([a, b, c], 'demo', 'file:///c'), a)
  assert.equal(journeyById([a, b, c], 'demo'), a)
  assert.equal(journeyById([a, b, c], 'gone', 'file:///a'), undefined)
})
