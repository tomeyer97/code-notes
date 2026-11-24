import { test } from 'node:test'
import assert from 'node:assert/strict'
import ELK from 'elkjs/lib/elk.bundled.js'
import { pageModule } from './pageModule'
import { parsed } from './goldenJourneys'

type Point = { x: number; y: number }
type Rect = Point & { w: number; h: number }
type Size = { w: number; h: number }
interface MapEdge { i: number; e: { from: string; to: string; label: string }; text: string; pts?: Point[]; bez?: Point[]; labelBox?: Rect }
interface MapLayout { w: number; h: number; abs: Map<string, Rect>; kids: Map<string, { id: string }[]>; edges: MapEdge[] }
interface Measure { title(n: unknown): Size; leaf(n: unknown, nums: number[]): Size; label(text: string): Size; done(): void }
interface LayoutModule {
  verb(label: string): string
  layout(j: unknown, measure: Measure, elk: unknown): Promise<MapLayout>
}

// media/journey-layout.js runs in the webview; it is bundled here as the page bundles it. Its layout takes the sizes
// and the ELK instance from the page, so it runs here without a DOM.
const L = pageModule<LayoutModule>('media/journey-layout.js')

test('an arrow label is its first clause without timings', () => {
  const cases: [string, string][] = [
    ['polls every 3 s, max 10 min', 'polls'],
    ['retries after up to 10 min', 'retries'],
    ['waits 30 s then reads the row', 'waits then reads the row'],
    ['times out within 5 seconds', 'times out'],
    ['reads (cached for 1 h)', 'reads'],
    ['marks it cancelling; the worker sees it', 'marks it cancelling'],
    ['watches in 2.5 ms steps', 'watches'],
    ['sends the 3 items', 'sends the 3 items'],
  ]
  for (const [label, want] of cases) assert.equal(verb(label), want, label)
})
const verb = (l: string) => L.verb(l)

/** Fixed sizes: a title 120 × 18, a leaf 10 px a character × 24, a label 6 px a character × 14. */
function fixedMeasure() {
  const asked = { titles: 0, leaves: 0, labels: [] as string[], done: 0 }
  const measure: Measure = {
    title: () => { asked.titles++; return { w: 120, h: 18 } },
    leaf: (n) => { asked.leaves++; return { w: 10 * String((n as { label: string }).label).length, h: 24 } },
    label: (text) => { asked.labels.push(text); return { w: 6 * text.length, h: 14 } },
    done: () => { asked.done++ },
  }
  return { measure, asked }
}

test('the layout is data: every box a rectangle inside the map, every arrow routed, labels placed', async () => {
  const j = parsed('shop-place-order')
  const { measure, asked } = fixedMeasure()
  const r = await L.layout(j, measure, new ELK())
  assert.equal(asked.done, 1, 'the measure is told it is done once')
  assert.equal(asked.titles + asked.leaves, j.nodes.length, 'each box measured once')
  for (const n of j.nodes) {
    const p = r.abs.get(n.id)
    assert.ok(p, `${n.id} has a rectangle`)
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= r.w + 0.5 && p.y + p.h <= r.h + 0.5, `${n.id} inside the map`)
  }
  assert.equal(r.edges.length, j.edges.length)
  for (const ed of r.edges) {
    // One way to draw it: its own curve, or ELK's route.
    assert.ok(!!ed.bez !== !!ed.pts, `edge ${ed.i}: a curve or a route, not both`)
    if (ed.bez) assert.equal(ed.bez.length, 4)
    assert.equal(!!ed.labelBox, !!ed.text, `edge ${ed.i}: a label box exactly when it has words`)
  }
  assert.deepEqual(asked.labels, r.edges.filter((ed) => ed.text).map((ed) => ed.text), 'each label measured once, as drawn')
})

test('the layout leaves the journey as it was given', async () => {
  const j = parsed('fixture-order-lifecycle')
  const before = JSON.stringify(j)
  await L.layout(j, fixedMeasure().measure, new ELK())
  assert.equal(JSON.stringify(j), before)
})
