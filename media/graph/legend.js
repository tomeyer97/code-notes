// The map's legend ("?"): what the arrows, boxes and numbers mean; placed in a corner where it covers not the
// current step's box.
import { el, svgEl } from '../common.js'

/** The legend's distance (px) from the view's sides. */
const INSET = 6
/** Its distance (px) above the controls' row, under the drawing. */
const ABOVE_CONTROLS = 4

/** The legend's rows (`leg` emptied first): a sample, what it means. @param {HTMLElement} leg */
export function paintLegend(leg) {
  leg.textContent = ''
  const row = (sample, text) => {
    const r = el('div', 'gkey')
    r.append(sample, document.createTextNode(text))
    leg.append(r)
  }
  const arrow = (cls) => {
    const s = svgEl('svg', { width: 26, height: 8, 'aria-hidden': 'true' })
    s.append(svgEl('path', { d: 'M1,4 H25', class: `gedge ${cls}` }))
    return s
  }
  row(arrow(''), 'call')
  row(arrow('async'), 'later (poll, watch)')
  row(el('span', 'gsample store'), "the app's own record")
  row(el('span', 'gnum', '4'), 'step (click to go)')
  row(el('span', 'gsample cur'), 'this step · drag to move, Ctrl+wheel to zoom')
}

/**
 * The corners the legend may take, in order: above the controls at the right, above them at the left, top right,
 * top left. `below`: the room (px) from the view's bottom to the drawing's.
 */
function corners(below) {
  return [
    { name: 'controls right', right: INSET, bottom: below },
    { name: 'controls left', left: INSET, bottom: below },
    { name: 'top right', right: INSET, top: INSET },
    { name: 'top left', left: INSET, top: INSET },
  ]
}

/** Legend `leg` set in `corner`. */
function putIn(leg, corner) {
  const px = (v) => (v === undefined ? '' : `${v}px`)
  Object.assign(leg.style, { left: px(corner.left), right: px(corner.right), top: px(corner.top), bottom: px(corner.bottom) })
}

/** Rectangle `r` is clear of `avoid` (both screen rectangles). @param {DOMRect} r @param {DOMRect} avoid */
const fits = (r, avoid) => !(r.left < avoid.right && avoid.left < r.right && r.top < avoid.bottom && avoid.top < r.bottom)

/**
 * Legend `leg` in the first corner where it does not cover `avoid` (the current step's box on screen; none: the
 * first corner); in the first when none is clear. `view`: the map's viewport, `stage`: its drawing.
 * @param {HTMLElement} leg @param {HTMLElement} view @param {HTMLElement} stage @param {DOMRect} [avoid]
 */
export function placeLegend(leg, view, stage, avoid) {
  const below = view.clientHeight - stage.offsetTop - stage.offsetHeight + ABOVE_CONTROLS
  const all = corners(below)
  for (const corner of all) {
    putIn(leg, corner)
    if (!avoid || fits(leg.getBoundingClientRect(), avoid)) return
  }
  putIn(leg, all[0])
}
