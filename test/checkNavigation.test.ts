// Ctrl+' D / A through the check's open questions (src/check/navigation.ts nextOpen).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextOpen } from '../src/check/navigation'

/** Questions q1..q5; `open` lists the open ones, `shown` the one shown now (if any). */
function next(open: number[], shown: number | undefined, dir: 1 | -1): number | undefined {
  const qs = [1, 2, 3, 4, 5]
  return nextOpen(qs, (q) => open.includes(q), (q) => q === shown, dir)
}

/** The extension's order before (four slices and two reverses), to compare with on every case. */
function before(open: number[], shown: number | undefined, dir: 1 | -1): number | undefined {
  const qs = [1, 2, 3, 4, 5]
  const o = qs.filter((q) => open.includes(q))
  if (!o.length) return undefined
  const at = qs.findIndex((q) => q === shown)
  const from = Math.max(0, at)
  const order = dir === 1 ? [...qs.slice(at + 1), ...qs.slice(0, at + 1)] : [...qs.slice(0, from).reverse(), ...qs.slice(from).reverse()]
  return order.find((q) => o.includes(q) && q !== shown) ?? o[0]
}

test('D goes to the next open question after the one shown, wrapping around', () => {
  assert.equal(next([2, 4], 2, 1), 4)
  assert.equal(next([2, 4], 4, 1), 2)
  assert.equal(next([1, 3], 5, 1), 1)
})

test('A goes to the previous open question, wrapping around', () => {
  assert.equal(next([2, 4], 4, -1), 2)
  assert.equal(next([2, 4], 2, -1), 4)
})

test('nothing shown: D starts at the first question, A at the last', () => {
  assert.equal(next([2, 4], undefined, 1), 2)
  assert.equal(next([2, 4], undefined, -1), 4)
})

test('the only open question shown: it again; none open: none', () => {
  assert.equal(next([3], 3, 1), 3)
  assert.equal(next([], 3, 1), undefined)
})

test('the same question as before for every shown question, open set and direction', () => {
  const sets = [[], [1], [5], [2, 4], [1, 3, 5], [1, 2, 3, 4, 5]]
  for (const open of sets) for (const shown of [undefined, 1, 2, 3, 4, 5]) for (const dir of [1, -1] as const) {
    assert.equal(next(open, shown, dir), before(open, shown, dir), `open ${open} shown ${shown} dir ${dir}`)
  }
})
