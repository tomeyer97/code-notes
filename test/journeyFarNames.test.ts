import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

type Rect = { x: number; y: number; w: number; h: number }
type Variant = { text: string; w: number; h: number; bare?: boolean; row?: boolean; line?: number }
interface FakeEl { style: Record<string, string>; firstChild: { textContent: string }; classList: { toggle(c: string, on?: boolean): void }; querySelector(): null }
interface Item { name: { el: FakeEl; id: string; label: string; kind: string; nums: number[]; variants: unknown }; blockRect: Rect; isCurrentBlock: boolean; rank: number; size: number }
interface FarNamesModule { place(items: Item[], taken: Rect[], ring: Rect | undefined): void }

// Placing the map's far names (media/journey-farnames.js), bundled as the page bundles it; the names are fake
// elements (placing only sets their style and text), their variants given.
const F = pageModule<FarNamesModule>('media/journey-farnames.js')

const fakeEl = (): FakeEl => ({ style: {}, firstChild: { textContent: '' }, classList: { toggle: () => undefined }, querySelector: () => null })
const v = (text: string, w: number, h: number): Variant => ({ text, w, h })
/** A block of leaves named `label`, `w` wide on screen. */
function block(id: string, label: string, blockRect: Rect, rank: number, isCurrentBlock = false): Item {
  const whole = v(label, label.length * 7, 20)
  const variants = { whole, two: [], cut: [], bareCut: [] }
  return { name: { el: fakeEl(), id, label, kind: 'inner', nums: [], variants }, blockRect, isCurrentBlock, rank, size: blockRect.w * blockRect.h }
}
const placedAt = (i: Item) => (i.name.el.style.display === 'none' ? undefined : { x: Number.parseFloat(i.name.el.style.left), y: Number.parseFloat(i.name.el.style.top) })

test('a name goes where nothing is: centred in its block first', () => {
  const a = block('a', 'Orders', { x: 0, y: 0, w: 200, h: 60 }, 2)
  const taken: Rect[] = []
  F.place([a], taken, undefined)
  assert.deepEqual(placedAt(a), { x: 100 - 42 / 2, y: 30 - 10 })
  assert.equal(taken.length, 1, 'the placed name is taken')
})

test('the current step\'s names go over the ring rather than nowhere; others never do', () => {
  const ring = { x: -10, y: -10, w: 400, h: 400 }
  const own = block('own', 'Orders', { x: 0, y: 0, w: 200, h: 60 }, 0, true)
  const other = block('other', 'Payments', { x: 0, y: 100, w: 200, h: 60 }, 2)
  const legend = { x: 1000, y: 1000, w: 10, h: 10 }
  const taken = [legend]
  F.place([other, own], taken, ring)
  assert.ok(placedAt(own), 'the current step\'s block is named, over the ring')
  assert.equal(placedAt(other), undefined, 'another block under the ring is hidden')
  assert.deepEqual(taken[0], legend, 'what was taken stays (the ring is not in it)')
  assert.equal(taken.length, 2)
})

test('higher ranks are placed first; among equals, the bigger box', () => {
  const small = block('s', 'Small', { x: 0, y: 0, w: 120, h: 40 }, 2)
  const big = block('b', 'Bigger', { x: 0, y: 0, w: 120, h: 50 }, 2)
  const first = block('f', 'First', { x: 0, y: 0, w: 120, h: 40 }, 1)
  F.place([small, big, first], [], undefined)
  assert.ok(placedAt(first) && placedAt(big), 'the ones placed first get their place')
})
