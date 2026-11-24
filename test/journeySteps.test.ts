// Where a journey's steps are (src/journeys/steps.ts, stepFinder.ts, keys.ts): carried over a reload, captured anchors,
// placed in new lines. Pure logic: the journeys here are plain steps and places, no workspace folder or URI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Journey } from '../src/core/format/journeyModel'
import { journeyOf } from './formats'
import { compactOf } from '../src/core/anchors/compact'
import {
  JourneySteps, StepAt, captureStepAnchor, carryPositions, fileOf, isEmptyAnchor, journeyById, journeyPosKey, placeStep,
  sameAnchor, sameStepAt, writtenAt,
} from '../src/journeys/steps'
import { stepFinder } from '../src/journeys/stepFinder'
import { keys } from '../src/journeys/keys'
import { dirPath, pathIn } from '../src/core/paths'

const code = ['import x', '', 'function f() {', '  a()', '  x()', '  y()', '  b()', '}', '', 'function g() {}']
const journey = (steps: object[]) => journeyOf(JSON.stringify({ version: 2, nodes: [{ id: 'n', label: 'N' }], steps }), 'j')
const step = (o: object = {}) => ({ id: 's1', node: 'n', file: 'src/a.ts', range: { start: 3, end: 8 }, title: 'f', ...o })
const placed = (j: Journey, at?: StepAt[]): JourneySteps => ({ j, at: at ?? writtenAt(j) })

test('pathIn / dirPath: a path inside a folder, never one that only starts with its name', () => {
  assert.equal(dirPath({ path: '/w' }), '/w/')
  assert.equal(dirPath({ path: '/w/' }), '/w/')
  assert.equal(pathIn({ path: '/w' }, { path: '/w/src/a.ts' }), 'src/a.ts')
  assert.equal(pathIn({ path: '/w' }, { path: '/w2/a.ts' }), undefined)
})

test('fileOf: the step\'s file, or where it was renamed to', () => {
  const lj = placed(journey([step()]))
  assert.equal(fileOf(lj, 1), 'src/a.ts')
  lj.at[0] = { ...lj.at[0], file: 'src/b.ts' }
  assert.equal(fileOf(lj, 1), 'src/b.ts')
})

test('journeyPosKey: the journey\'s folder and id (the same id in two folders is two journeys)', () => {
  assert.equal(journeyPosKey('file:///w', 'demo'), 'file:///w|demo')
  assert.notEqual(journeyPosKey('file:///v', 'demo'), journeyPosKey('file:///w', 'demo'))
})

test('keys: a step by journey, id, file and written start; a file by folder and path; a journey\'s file', () => {
  const s = { id: 's1', file: 'src/a.ts', range: { start: 3, end: 8 } }
  assert.equal(keys.step('file:///w/j.json', s), 'file:///w/j.json|s1|src/a.ts:3')
  assert.equal(keys.fileIn('file:///w', 'src/a.ts'), 'file:///w|src/a.ts')
  assert.equal(keys.journeyFile('file:///w/j.json', 'src/a.ts'), 'file:///w/j.json|src/a.ts')
})

test('carryPositions: the same steps keep where they were found; a changed step starts over', () => {
  const prev = placed(journey([step(), step({ id: 's2', range: { start: 8, end: 8 } })]))
  prev.at = [{ start: 13, end: 18, stale: false }, { start: 20, end: 20, stale: true }]
  const next = placed(journey([step({ id: 's2', range: { start: 9, end: 9 } }), step({ title: 'renamed title' })]))
  carryPositions(prev, next)
  assert.deepEqual(next.at, [{ start: 9, end: 9, stale: false }, { start: 13, end: 18, stale: false }], 's2 moved in the file: not carried; s1 only retitled: carried')
})

test('carryPositions: a step whose anchor changed starts over', () => {
  const anchor = { text: 'function f() {', before: 'import x', after: '  a()' }
  const prev = placed(journey([step({ anchor })]), [{ start: 13, end: 18, stale: false }])
  const same = placed(journey([step({ anchor: { ...anchor } })]))
  carryPositions(prev, same)
  assert.deepEqual(same.at, prev.at, 'an equal anchor (another object): carried')
  const edited = placed(journey([step({ anchor: { ...anchor, after: '  b()' } })]))
  carryPositions(prev, edited)
  assert.deepEqual(edited.at, [{ start: 3, end: 8, stale: false }])
})

test('sameAnchor: the same kind and every field equal, whatever the key order', () => {
  const c = compactOf(code, 2, 7)!
  const reordered = Object.fromEntries(Object.entries(c).reverse()) as typeof c
  assert.ok(sameAnchor(c, reordered) && sameAnchor(undefined, undefined))
  assert.ok(!sameAnchor(c, { ...c, hash: 'other' }) && !sameAnchor(c, undefined))
  const full = { text: 'x', before: 'a', after: 'b' }
  assert.ok(sameAnchor(full, { after: 'b', before: 'a', text: 'x' }))
  assert.ok(!sameAnchor(full, { ...full, before: 'c' }) && !sameAnchor(full, c))
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

test('placeStep: a full-text anchor with code is found as compact, its text the diff\'s old side', () => {
  const full = { text: code.slice(2, 8).join('\n'), before: 'import x\n', after: '\nfunction g() {}' }
  const was: StepAt = { start: 3, end: 8, stale: false }
  assert.deepEqual(placeStep(['// new', ...code], full, was, {}), { start: 4, end: 9, stale: false })
  const edited = [...code.slice(0, 5), '  z()', ...code.slice(6)]
  assert.deepEqual(placeStep(edited, full, was, {}), { start: 3, end: 8, stale: true, was: full.text, now: edited.slice(2, 8).join('\n') })
})

test('placeStep: a step on blank lines stays put, never moves to look-alike blank lines', () => {
  const blankStep = { text: '', before: '  b()\n}', after: 'function g() {}' }
  const was: StepAt = { start: 9, end: 9, stale: false }
  assert.deepEqual(placeStep(code, blankStep, was, {}), { start: 9, end: 9, stale: false })
  assert.deepEqual(placeStep(['x', ...code], blankStep, was, {}), { ...was, stale: true }, 'found elsewhere: stale where it was')
})

test('stepFinder: one find for both anchor kinds, in 0-based lines', () => {
  const near = { start: 2, end: 7 }
  assert.deepEqual(stepFinder(compactOf(code, 2, 7)!).find(code, near), { kind: 'fresh', loc: near })
  assert.deepEqual(stepFinder(compactOf(code, 2, 7)!).find(['other'], near), { kind: 'removed' })
  const blank = { text: '', before: '  b()\n}', after: 'function g() {}' }
  assert.deepEqual(stepFinder(blank).find(code, { start: 8, end: 8 }), { kind: 'fresh', loc: { start: 8, end: 8 } })
  assert.deepEqual(stepFinder(blank).find(['x', ...code], { start: 8, end: 8 }), { kind: 'elsewhere' })
})

test('journeyById: the journey with that id in the folder asked for, else the first with that id', () => {
  const inFolder = (folder: string, id: string) => ({ folder: { uri: folder }, j: { id } })
  const a = inFolder('file:///a', 'demo'), b = inFolder('file:///b', 'demo'), c = inFolder('file:///b', 'other')
  assert.equal(journeyById([a, b, c], 'demo', 'file:///b'), b)
  assert.equal(journeyById([a, b, c], 'demo', 'file:///c'), a)
  assert.equal(journeyById([a, b, c], 'demo'), a)
  assert.equal(journeyById([a, b, c], 'gone', 'file:///a'), undefined)
})
