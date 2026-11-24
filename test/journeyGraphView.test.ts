import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

type Rect = { x: number; y: number; w: number; h: number }
type Size = { w: number; h: number }
type View = { x: number; y: number; zoom: number }
interface ViewModule {
  ZOOM_MIN: number; ZOOM_MAX: number; READ: number; SHOW_MAX_ZOOM: number; FIT_MAX_ZOOM: number
  clampZoom(z: number): number
  clampOffset(x: number, y: number, zoom: number, map: Size, port: Size): { x: number; y: number }
  zoomedAt(view: View, factor: number, sx: number, sy: number): View
  showing(r: Rect, port: Size, maxZoom?: number): View
  following(p: Rect, near: Rect[], port: Size): View
  boundingBox(rects: Rect[]): Rect
  zoomToFit(r: Rect, port: Size): number
}

// The map's view maths (media/graph/view.js): pure, bundled as the page bundles it.
const V = pageModule<ViewModule>('media/graph/view.js')
const port = { w: 400, h: 300 }
/** Rectangle `r` (world px) on screen in `v`. */
const onScreen = (r: Rect, v: View) => ({ x: v.x + r.x * v.zoom, y: v.y + r.y * v.zoom, w: r.w * v.zoom, h: r.h * v.zoom })

test('the zoom stays within its bounds', () => {
  assert.equal(V.clampZoom(100), V.ZOOM_MAX)
  assert.equal(V.clampZoom(0), V.ZOOM_MIN)
  assert.equal(V.clampZoom(1), 1)
})

test('a map bigger than the view leaves no empty band; a smaller one stays inside it', () => {
  const big = { w: 1000, h: 1000 }
  assert.deepEqual(V.clampOffset(50, 50, 1, big, port), { x: 12, y: 12 })
  assert.deepEqual(V.clampOffset(-5000, -5000, 1, big, port), { x: 400 - 1000 - 12, y: 300 - 1000 - 12 })
  const small = { w: 100, h: 100 }
  assert.deepEqual(V.clampOffset(-50, 500, 1, small, port), { x: 12, y: 300 - 100 - 12 })
})

test('zooming about a point keeps that point where it is', () => {
  const v = { x: 30, y: -20, zoom: 0.8 }
  const z = V.zoomedAt(v, 1.25, 150, 100)
  assert.equal(z.zoom, 1)
  const world = { x: (150 - v.x) / v.zoom, y: (100 - v.y) / v.zoom }
  assert.ok(Math.abs(z.x + world.x * z.zoom - 150) < 1e-9 && Math.abs(z.y + world.y * z.zoom - 100) < 1e-9)
})

test('a rectangle shown is centred, with a margin, no closer than its zoom limit', () => {
  const r = { x: 100, y: 100, w: 50, h: 20 }
  const v = V.showing(r, port)
  assert.equal(v.zoom, V.SHOW_MAX_ZOOM)
  const s = onScreen(r, v)
  assert.ok(Math.abs(s.x + s.w / 2 - port.w / 2) < 1e-9 && Math.abs(s.y + s.h / 2 - port.h / 2) < 1e-9)
  const whole = V.showing({ x: 0, y: 0, w: 2000, h: 600 }, port, V.FIT_MAX_ZOOM)
  assert.equal(whole.zoom, (400 - 32) / 2000)
})

test('following a step: its box fully in view at a readable zoom, its neighbours when they fit', () => {
  const p = { x: 500, y: 500, w: 120, h: 30 }
  const near = [{ x: 700, y: 520, w: 100, h: 30 }, { x: 3000, y: 3000, w: 100, h: 30 }]
  const v = V.following(p, near, port)
  assert.ok(v.zoom >= V.READ - 1e-9, `readable (${v.zoom})`)
  const s = onScreen(p, v)
  assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= port.w && s.y + s.h <= port.h, 'the box in view')
  const n = onScreen(near[0], v)
  assert.ok(n.x >= 0 && n.x + n.w <= port.w, 'the near neighbour in view')
})

test('the bounding box of rectangles', () => {
  assert.deepEqual(V.boundingBox([{ x: 1, y: 2, w: 3, h: 4 }, { x: -1, y: 5, w: 1, h: 1 }]), { x: -1, y: 2, w: 5, h: 4 })
})
