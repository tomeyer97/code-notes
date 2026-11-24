// The map's input: drag to pan, the wheel pans (Ctrl or ⌘: zooms), + − 0 and the arrow keys on the focused map.
import { runKey } from '../common.js'
import { ZOOM_STEP } from './view.js'

/** A press moves this far (px) before it is a drag (less is a click). */
const DRAG_THRESHOLD_PX = 4
/** A wheel delta this big or bigger is a mouse wheel's notch (~100); smaller ones are a pinch's or a trackpad's. */
const WHEEL_NOTCH = 50
/** Zoom per px of wheel delta: a notch, and a pinch's small steps (so both feel alike). */
const WHEEL_ZOOM_RATE = 0.0015, PINCH_ZOOM_RATE = 0.01
/** A wheel that scrolls by lines: px per line. */
const LINE_PX = 16
/** How far an arrow key pans (px). */
const PAN_STEP = 60

/**
 * What the input moves (journey-graph.js): the view's offset, kept in bounds (`clamped`) and set at once (`jumpTo`)
 * or animated (`panTo`); zooming about a point or the middle; fitting the whole map.
 * @typedef {{ view(): import('./view.js').View, hasLayout(): boolean, isTutorialUp(): boolean,
 *   clamped(x: number, y: number): { x: number, y: number }, jumpTo(x: number, y: number): void,
 *   panTo(x: number, y: number): void, stopAnimation(): void, zoomAt(factor: number, sx: number, sy: number): void,
 *   zoomBy(factor: number): void, fit(): void }} InputPort
 */

/** Drag, wheel and keys on `viewport` (the map's element; its own listeners, gone with it). @param {HTMLElement} viewport @param {InputPort} port */
export function listenForInput(viewport, port) {
  let drag = null, dragged = false
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || /** @type {HTMLElement} */ (e.target).closest('.gctl, .glegend')) return
    const { x, y } = port.view()
    drag = { sx: e.clientX, sy: e.clientY, x, y, id: e.pointerId, on: false }
    dragged = false
  })
  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
    if (!drag.on && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!drag.on) {
      drag.on = true
      dragged = true
      port.stopAnimation()
      viewport.setPointerCapture(e.pointerId)
      viewport.classList.add('dragging')
    }
    const c = port.clamped(drag.x + dx, drag.y + dy)
    port.jumpTo(c.x, c.y)
  })
  const end = () => { if (drag?.on) viewport.classList.remove('dragging'); drag = null }
  viewport.addEventListener('pointerup', end)
  viewport.addEventListener('pointercancel', end)
  // A drag is not a click on what it started on.
  viewport.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false } }, true)
  viewport.addEventListener('wheel', (e) => wheel(viewport, port, e), { passive: false })
  viewport.addEventListener('keydown', (e) => {
    if (port.isTutorialUp() || e.ctrlKey || e.altKey || e.metaKey) return
    const pan = (dx, dy) => () => { const { x, y } = port.view(); port.panTo(x + dx, y + dy) }
    runKey(e, {
      '+': () => port.zoomBy(ZOOM_STEP),
      '=': () => port.zoomBy(ZOOM_STEP),
      '-': () => port.zoomBy(1 / ZOOM_STEP),
      '_': () => port.zoomBy(1 / ZOOM_STEP),
      '0': () => port.fit(),
      ArrowLeft: pan(PAN_STEP, 0),
      ArrowRight: pan(-PAN_STEP, 0),
      ArrowUp: pan(0, PAN_STEP),
      ArrowDown: pan(0, -PAN_STEP),
    }, true)
  })
}

/** The wheel: Ctrl or ⌘ zooms about the pointer; else it pans, and at the map's edge the page scrolls on (the map
 *  never traps the wheel). @param {HTMLElement} viewport @param {InputPort} port @param {WheelEvent} e */
function wheel(viewport, port, e) {
  if (!port.hasLayout()) return
  const r = viewport.getBoundingClientRect()
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    const rate = Math.abs(e.deltaY) >= WHEEL_NOTCH ? WHEEL_ZOOM_RATE : PINCH_ZOOM_RATE
    port.zoomAt(Math.exp(-e.deltaY * rate), e.clientX - r.left, e.clientY - r.top)
    return
  }
  const f = e.deltaMode === 1 ? LINE_PX : 1
  const { x, y } = port.view()
  const c = port.clamped(x - e.deltaX * f, y - e.deltaY * f)
  if (Math.abs(c.x - x) < 0.5 && Math.abs(c.y - y) < 0.5) return
  e.preventDefault()
  port.stopAnimation()
  port.jumpTo(c.x, c.y)
}
