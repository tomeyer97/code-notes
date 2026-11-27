// The map's view maths (journey-graph.js moves the view with them): which part of the map is on screen at which
// zoom. Pure: rectangles and sizes in, a view out; unit-tested in test/journeyGraphView.test.ts.
// A view is { x, y, zoom }: screen = world * zoom + (x, y).
import { between } from '../common.js'

/** @typedef {{ x: number, y: number, zoom: number }} View */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ w: number, h: number }} Size */

/** Zoom bounds: out far enough for a big journey on a small panel, in until a box fills it. */
export const ZOOM_MIN = 0.12, ZOOM_MAX = 2.5
/** Below this zoom the leaves' text and the arrow labels are too small to read: hidden, far names drawn instead. */
export const FAR = 0.55
/** The zoom a box is readable at: follow() keeps the current step's box at least this close when it can. */
export const READ = 0.8
/** One step of + and − (the buttons and the keys). */
export const ZOOM_STEP = 1.25
/** The margin (px) kept around a rectangle shown (show()): its edges never touch the view's. */
const SHOW_PAD = 16
/** The closest show() zooms to (a box clicked): close, not filling the view. */
export const SHOW_MAX_ZOOM = 1.4
/** The closest the whole map is fitted at (a small map is not blown up). */
export const FIT_MAX_ZOOM = 1.2
/** The closest follow() zooms to when the step's box and its neighbourhood all fit: a little over readable. */
const FOLLOW_MAX_ZOOM = 1.1
/** The margin (px) around what follow() keeps in view. */
const FOLLOW_PAD = 28
/** The margin (px) clamp() keeps between the map's edge and the view's. */
const EDGE_MARGIN = 12

/** Zoom `zoom` within ZOOM_MIN..ZOOM_MAX. */
export const clampZoom = (zoom) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom))

/** The offset (x, y) at `zoom` kept so no empty band shows at an edge while the map (`map`, world px) is bigger than
 *  the view (`port`), and a smaller map stays inside it; both EDGE_MARGIN from the view's edges.
 *  @param {Size} map @param {Size} port @returns {{ x: number, y: number }} */
export function clampOffset(x, y, zoom, map, port) {
  const m = EDGE_MARGIN
  // One axis: offset v of a map `size` long in a view `view` long.
  const one = (v, size, view) => {
    if (size + 2 * m <= view) return between(v, m, view - size - m)
    return between(v, view - size - m, m)
  }
  return { x: one(x, map.w * zoom, port.w), y: one(y, map.h * zoom, port.h) }
}

/** `view` zoomed by `factor` about the screen point (sx, sy) (it stays where it is). @param {View} view @returns {View} */
export function zoomedAt(view, factor, sx, sy) {
  const zoom = clampZoom(view.zoom * factor)
  const wx = (sx - view.x) / view.zoom, wy = (sy - view.y) / view.zoom
  return { x: sx - wx * zoom, y: sy - wy * zoom, zoom }
}

/** The view with world point `c` at the middle of `port`, at `zoom`. @param {Size} port @returns {View} */
export const centredOn = (c, zoom, port) => ({ x: port.w / 2 - c.x * zoom, y: port.h / 2 - c.y * zoom, zoom })

/** Rectangle `r` (world px) in view with SHOW_PAD around it, at most `maxZoom`; centred on `center` (default: its
 *  middle). @param {Rect} r @param {Size} port @returns {View} */
export function showing(r, port, maxZoom = SHOW_MAX_ZOOM, center = undefined) {
  const zoom = Math.max(ZOOM_MIN, Math.min(maxZoom, (port.w - 2 * SHOW_PAD) / r.w, (port.h - 2 * SHOW_PAD) / r.h))
  return centredOn(center || { x: r.x + r.w / 2, y: r.y + r.h / 2 }, zoom, port)
}

/**
 * The current step's box `p` at a readable zoom with its neighbourhood (`near`: the boxes its arrows reach) in view
 * when that fits at READ or more; centred on the neighbourhood, the box itself always fully in view.
 * @param {Rect} p @param {Rect[]} near @param {Size} port @returns {View}
 */
export function following(p, near, port) {
  const around = [p, ...near]
  // Drop the farthest neighbours until the rest fit at a readable zoom.
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2
  const away = (r) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy)
  around.sort((a, b) => away(a) - away(b))
  let n = around.length
  while (n > 1 && zoomToFit(boundingBox(around.slice(0, n)), port) < READ) n--
  // All of them in view: as close as FOLLOW_MAX_ZOOM; else at the readable zoom, leaning toward them all.
  const all = n === around.length
  const r = boundingBox(around)
  const readable = Math.min(READ, zoomToFit(p, port))
  const zoom = all ? Math.max(readable, Math.min(FOLLOW_MAX_ZOOM, zoomToFit(r, port))) : readable
  // The neighbourhood's centre, moved toward the box as far as needed to keep the box in view.
  const slackX = Math.max(0, (port.w / 2 - FOLLOW_PAD) / zoom - p.w / 2)
  const slackY = Math.max(0, (port.h / 2 - FOLLOW_PAD) / zoom - p.h / 2)
  const c = {
    x: between(r.x + r.w / 2, cx - slackX, cx + slackX),
    y: between(r.y + r.h / 2, cy - slackY, cy + slackY),
  }
  return centredOn(c, zoom, port)
}

/** The smallest rectangle holding `rects` (all { x, y, w, h }). @param {Rect[]} rects @returns {Rect} */
export function boundingBox(rects) {
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The zoom at which rectangle `r` (world px) just fits `port`, FOLLOW_PAD around it. @param {Rect} r @param {Size} port */
export function zoomToFit(r, port) {
  return Math.min((port.w - 2 * FOLLOW_PAD) / r.w, (port.h - 2 * FOLLOW_PAD) / r.h)
}
