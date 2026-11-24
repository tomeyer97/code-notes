// The journey panel's splitter and its width rules: when the map (or a step's animation) goes beside the storyline,
// how wide each may be, and the handle between them that drags the map column's width (wide panels only).
// Made by journey-map.js:
//   const s = JourneySplitter(app, { onResize() (the map's width changed under the hand), onKeep(w) (the width chosen) })
//   s.el(body)  s.widthTo(body, w)  s.dragging; and mapFits(panelW), besideFits(panelW, anim)
import { el, runKey } from './common.js'

/** The map column and the storyline beside it are at least this wide (px); a panel narrower than MAPMIN shows no map. */
const MAPMIN = 240, STORYMIN = 280
/** While the animation plays its column is at least SCENEMIN wide (so its text is never under 11 px), still beside the
 *  storyline, which may narrow to STORYANIM. */
const SCENEMIN = 400, STORYANIM = 160
/** The splitter's column with the gaps beside it (13 + 2 × 4 px), and the panel's padding (16 px each side). */
const SPLITTER_W = 21, GUTTER = 32
/** The map goes beside the storyline from this panel width (no animation playing). */
const WIDE_MIN = 520
/** The animation's column when no width was chosen: this share of the panel (the map's default is in
 *  journey-map.css: `--mapw`'s fallback). */
const DEFAULT_SCENE_SHARE = 0.54
/** How far ← → move the splitter (px). */
const SPLITTER_STEP = 24

/** A panel `panelW` px wide has room for the map. */
export const mapFits = (panelW) => panelW >= MAPMIN
/** A panel `panelW` px wide has room for the map (or, `anim`, the animation) beside the storyline. */
export const besideFits = (panelW, anim) => panelW >= (anim ? SCENEMIN + STORYANIM + SPLITTER_W + GUTTER : WIDE_MIN)

const animating = (body) => body.classList.contains('anim')
const minW = (body) => (animating(body) ? SCENEMIN : MAPMIN)
/** The widest the map may be in this body: the storyline keeps its minimum. */
const maxW = (body) => {
  const story = animating(body) ? STORYANIM : STORYMIN
  return Math.max(minW(body), body.clientWidth - story - SPLITTER_W)
}

export function JourneySplitter(app, { onResize, onKeep }) {
  /** The splitter is being dragged (a tour message doesn't move the map's width meanwhile). */
  let dragging = false
  /** The map column's width on screen (the map's or the animation's). */
  const shownW = () => app.querySelector('.mapwrap')?.offsetWidth || 0

  /** Sets the map column to `w` px (0: the default), clamped. */
  function widthTo(body, w) {
    if (!w && animating(body)) w = Math.max(SCENEMIN, body.clientWidth * DEFAULT_SCENE_SHARE)
    if (w) {
      const clamped = Math.max(minW(body), Math.min(maxW(body), w))
      body.style.setProperty('--mapw', `${Math.round(clamped)}px`)
    } else body.style.removeProperty('--mapw')
    const sp = body.querySelector('.splitter')
    if (sp) sp.setAttribute('aria-valuenow', String(Math.round(shownW())))
  }

  /** The handle between the storyline and the map in `body`: drag, double-click (the default), ← →. */
  function splitterEl(body) {
    const s = el('div', 'splitter')
    s.tabIndex = 0
    s.setAttribute('role', 'separator')
    s.setAttribute('aria-orientation', 'vertical')
    s.setAttribute('aria-label', 'Map width')
    s.title = 'Drag to resize the map (double-click: default)'
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
    s.addEventListener('pointermove', (e) => {
      if (!dragging) return
      widthTo(body, w0 + (x0 - e.clientX))
      onResize()
    })
    const release = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing')
      onKeep(shownW())
    }
    s.addEventListener('pointerup', release)
    s.addEventListener('pointercancel', release)
    s.addEventListener('dblclick', () => {
      widthTo(body, 0)
      onResize()
      onKeep(0)
    })
    s.addEventListener('keydown', (e) => {
      const by = (d) => () => {
        widthTo(body, shownW() + d)
        onResize()
        onKeep(shownW())
      }
      runKey(e, { ArrowLeft: by(SPLITTER_STEP), ArrowRight: by(-SPLITTER_STEP) })
    })
    return s
  }

  return {
    el: splitterEl,
    widthTo,
    get dragging() { return dragging },
  }
}
