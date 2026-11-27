// The journey panel's splitter and its width rules: when the map (or a step's animation) goes beside the storyline,
// how wide each may be, and the handle between them that drags the map column's width (wide panels only).
// The widths live here; applyWidths() hands the ones the stylesheet lays the wide panel out with to journey-map.css as
// custom properties (the panel's own padding is the stylesheet's: PANEL_PAD_X restates it).
// Made by journey-map.js:
//   const s = JourneySplitter(app, { onResize() (the map's width changed under the hand), onKeep(w) (the width chosen) })
//   s.makeHandle(body, anim)  s.widthTo(body, w, anim)  s.dragging; and JourneyWidths.mapFits / besideFits
import { el, runKey } from './common.js'

/** The map column and the storyline beside it are at least this wide (px); a panel narrower than MAPMIN shows no map. */
const MAPMIN = 240, STORYMIN = 280
/** While the animation plays its column is at least SCENEMIN wide (so its text is never under 11 px), still beside the
 *  storyline, which may narrow to STORYANIM. */
const SCENEMIN = 400, STORYANIM = 160
/** The splitter's column and the gap on each side of it (px). */
const SPLITTER_COL = 13, SPLITTER_GAP = 4
const SPLITTER_W = SPLITTER_COL + 2 * SPLITTER_GAP
/** The panel's padding on each side (px): journey-map.css #app's, which is drawn before this script runs. */
const PANEL_PAD_X = 16
const GUTTER = 2 * PANEL_PAD_X
/** The map goes beside the storyline from this panel width (no animation playing). */
const WIDE_MIN = 520
/** The map's (and the animation's) column when no width was chosen: this share of the panel. */
const DEFAULT_SHARE = 0.54
/** How far ← → move the splitter (px). */
const SPLITTER_STEP = 24

/** The widths the stylesheet lays the panel out with (journey-map.css), set on `root` once at startup. */
export function applyWidths(root) {
  root.style.setProperty('--splitter-col', `${SPLITTER_COL}px`)
  root.style.setProperty('--splitter-gap', `${SPLITTER_GAP}px`)
  root.style.setProperty('--map-share', `${DEFAULT_SHARE * 100}%`)
}

/** What fits in a panel `panelW` px wide. */
export const JourneyWidths = {
  /** Room for the map. */
  mapFits: (panelW) => panelW >= MAPMIN,
  /** Room for the map (or, `anim`, the animation) beside the storyline. */
  besideFits: (panelW, anim) => panelW >= (anim ? SCENEMIN + STORYANIM + SPLITTER_W + GUTTER : WIDE_MIN),
}

/** The narrowest the map column may be (`anim`: the animation is in it). */
const minW = (anim) => (anim ? SCENEMIN : MAPMIN)
/** The widest the map column may be in `body`: the storyline keeps its minimum. */
const maxW = (body, anim) => Math.max(minW(anim), body.clientWidth - (anim ? STORYANIM : STORYMIN) - SPLITTER_W)

export function JourneySplitter(app, { onResize, onKeep }) {
  /** The splitter is being dragged (a tour message doesn't move the map's width meanwhile). */
  let dragging = false
  /** The map column's width on screen (the map's or the animation's). */
  const shownW = () => app.querySelector('.mapwrap')?.offsetWidth || 0

  /** Sets the map column to `w` px (0: the default), clamped; `anim`: the animation is in it. */
  function widthTo(body, w, anim) {
    if (!w && anim) w = Math.max(SCENEMIN, body.clientWidth * DEFAULT_SHARE)
    if (w) {
      const clamped = Math.max(minW(anim), Math.min(maxW(body, anim), w))
      body.style.setProperty('--mapw', `${Math.round(clamped)}px`)
    } else body.style.removeProperty('--mapw')
    const sp = body.querySelector('.splitter')
    if (sp) sp.setAttribute('aria-valuenow', String(Math.round(shownW())))
  }

  /** A new handle between the storyline and the map in `body`: drag, double-click (the default), ← →. */
  function makeHandle(body, anim) {
    const s = el('div', 'splitter')
    s.tabIndex = 0
    s.setAttribute('role', 'separator')
    s.setAttribute('aria-orientation', 'vertical')
    s.setAttribute('aria-label', 'Map width')
    s.title = 'Drag to resize the map (double-click: default)'
    const resizeTo = (w) => { widthTo(body, w, anim); onResize() }
    let x0 = 0, w0 = 0
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging = true
      x0 = e.clientX
      w0 = shownW()
      s.setPointerCapture(e.pointerId)
      document.body.classList.add('resizing')
    })
    s.addEventListener('pointermove', (e) => { if (dragging) resizeTo(w0 + (x0 - e.clientX)) })
    const release = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing')
      onKeep(shownW())
    }
    s.addEventListener('pointerup', release)
    s.addEventListener('pointercancel', release)
    s.addEventListener('dblclick', () => { resizeTo(0); onKeep(0) })
    s.addEventListener('keydown', (e) => {
      const by = (d) => () => { resizeTo(shownW() + d); onKeep(shownW()) }
      runKey(e, { ArrowLeft: by(SPLITTER_STEP), ArrowRight: by(-SPLITTER_STEP) })
    })
    return s
  }

  return {
    makeHandle,
    widthTo,
    get dragging() { return dragging },
  }
}
