// The journey's whole map at once, as a view: the boxes and arrows where journey-layout.js put them (cached per
// journey), far names when zoomed out (journey-farnames.js), pan (drag, wheel), zoom (Ctrl+wheel, + − Fit, keys), and
// it follows the step: the current step's box centred at a readable zoom, ringed. Function boxes carry their step
// numbers. Its parts: graph/view.js (the view maths), graph/draw.js (drawing), graph/legend.js, graph/input.js.
// One map per page (journey-map.js makes it): it listens on the document for the legend's Esc and outside click;
// dispose() removes those listeners.
import { el } from './common.js'
import { layout as layoutJourney, signature, stepsOf, ancestors } from './journey-layout.js'
import * as FarNames from './journey-farnames.js'
import { measureBoxes } from './graph/boxes.js'
import { drawMap, markBoxes, markEdges, placeEl } from './graph/draw.js'
import { paintLegend, placeLegend } from './graph/legend.js'
import { listenForInput } from './graph/input.js'
import {
  FAR, ZOOM_STEP, FIT_MAX_ZOOM, SHOW_MAX_ZOOM, clampZoom, clampOffset, zoomedAt, showing, following,
} from './graph/view.js'

/** A view move's animation (ms), eased out. */
const MOVE_MS = 320
/** The ring around the current step's box when zoomed out: this far (px) outside it, at least this big (px). */
const RING_MARGIN = 3, RING_MIN = 10
/** The legend keeps this far (px) from far names placed around it. */
const LEGEND_CLEARANCE = 2
/** Layouts kept, by journey content (a tour message never lays out again; an edited journey does once): the last
 *  few journeys opened. */
const LAYOUTS_KEPT = 8
/** @type {Map<string, import('./journey-layout.js').MapLayout>} */
const layouts = new Map()

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A layout kept, the most recently used last. */
function keptLayout(key) {
  const hit = layouts.get(key)
  if (hit) { layouts.delete(key); layouts.set(key, hit) }
  return hit
}
function keepLayout(key, value) {
  layouts.delete(key)
  layouts.set(key, value)
  while (layouts.size > LAYOUTS_KEPT) layouts.delete(/** @type {string} */ (layouts.keys().next().value))
}

/** The journey laid out with the page's styles (async: a measuring or ELK error is a rejection). */
async function layOut(j) {
  return layoutJourney(j, measureBoxes(), new window.ELK())
}

/**
 * What the map tells and asks the page (journey-map.js): go to step n, open a path, whether the tutorial is up
 * (nothing moves, nothing opens then), the legend shown or hidden, drawn (its box count), the box it follows
 * ('' none), a layout error.
 * @typedef {{ goStep(n: number): void, open(path: string): void, isTutorialUp(): boolean, legend(hidden: boolean): void,
 *   rendered(boxes: number): void, view(node: string): void, error(message: string): void }} GraphHost
 */

/**
 * The map. `el`: its viewport (the page appends it on every render); `set(journey, current, legendHidden)`: what it
 * shows; `placed()`: it is in the page (follow a new step); `resized()`: its width changed under the reader's hand;
 * `dispose()`: its document listeners removed.
 * @param {GraphHost} host
 */
export function JourneyGraph(host) {
  const viewport = el('div', 'gmap')
  viewport.tabIndex = 0
  viewport.setAttribute('role', 'group')
  viewport.setAttribute('aria-label', 'Map. Drag to move, Ctrl+wheel to zoom, 0 fits.')
  // The drawing: the controls sit in a row under it, never over anything drawn.
  const stage = el('div', 'gstage')
  viewport.append(stage)
  const world = el('div', 'gworld')
  stage.append(world)
  /** Far out: the names, at a size you can read, over the boxes (screen space, not scaled). */
  const names = el('div', 'gnames')
  names.setAttribute('aria-hidden', 'true')
  // Hidden until a far view has placed them: unplaced, every name sits at the top left, over the others.
  names.hidden = true
  stage.append(names)
  const ctl = el('div', 'gctl')
  const btn = (cls, text, title, fn) => {
    const b = el('button', `gbtn ${cls}`, text)
    b.title = title
    b.setAttribute('aria-label', title)
    b.onclick = (e) => { e.stopPropagation(); fn() }
    ctl.append(b)
    return b
  }
  btn('gin', '+', 'Zoom in (+)', () => zoomBy(ZOOM_STEP))
  btn('gout', '−', 'Zoom out (−)', () => zoomBy(1 / ZOOM_STEP))
  btn('gfit', 'Fit', 'Show the whole map (0)', () => fit(true))
  const legendButton = btn('glegq', '?', 'What the map shows', () => showLegend(legendHidden))
  viewport.append(ctl)
  const legend = el('div', 'glegend')
  viewport.append(legend)

  // ---------- state ----------

  /** What the map shows: the journey and its nodes by id, the walk's step (0: none), its layout (`layoutKey`: the
   *  journey's signature it was made for; undefined while `laying` it out or after an error). */
  const shown = {
    journey: /** @type {any} */ (undefined),
    byId: new Map(),
    current: 0,
    layout: /** @type {import('./journey-layout.js').MapLayout | undefined} */ (undefined),
    layoutKey: '',
    laying: false,
  }
  /** The view: screen = world * zoom + (x, y). */
  const view = { x: 0, y: 0, zoom: 1 }
  /** The view's animation frame (0: none). */
  let anim = 0
  /** The step the map last followed (-1: none yet): a new one moves it (also back from wherever it was dragged). */
  let followed = -1
  /** The view was placed on the layout drawn (until then it is no view at all: the tutorial does not stop that). */
  let viewPlaced = false
  /** The view is the whole map the journey opened on (kept over size changes until the walk or the reader moves). */
  let openFit = false
  /** The view's size when the map last followed or was resized ({ w, h }; undefined: not yet). */
  let lastSize
  let legendHidden = true
  /** The drawing: boxes by node id, far names (measured once, when first placed), the current step's ring. */
  const drawn = {
    nodeEls: /** @type {Map<string, HTMLElement>} */ (new Map()),
    farNames: /** @type {import('./journey-farnames.js').FarName[]} */ ([]),
    measured: /** @type {import('./journey-farnames.js').MeasuredName[] | undefined} */ (undefined),
    ring: /** @type {HTMLElement | undefined} */ (undefined),
  }

  /** The current step's node (undefined: not walking). */
  const currentNode = () => (shown.current ? shown.journey?.steps[shown.current - 1]?.node : undefined)
  /** The box holding the current step's node. */
  const currentHolder = (node) => node && shown.byId.get(node)?.parent
  const port = () => ({ w: stage.clientWidth, h: stage.clientHeight })

  // ---------- the legend ----------

  function showLegend(on) { legendHidden = !on; host.legend(legendHidden); paintLegendNow() }
  function paintLegendNow() {
    legend.hidden = legendHidden
    legendButton.classList.toggle('on', !legendHidden)
    legendButton.setAttribute('aria-expanded', String(!legendHidden))
    if (legendHidden) return
    paintLegend(legend)
    placeLegendNow()
  }
  /** Above the controls, at their corner; another corner when it would cover the current step's box. */
  function placeLegendNow() {
    if (legendHidden || !viewport.isConnected) return
    const node = currentNode()
    const ringShown = viewport.classList.contains('far') && drawn.ring?.style.display !== 'none'
    const box = node && (ringShown ? drawn.ring : drawn.nodeEls.get(node))
    placeLegend(legend, viewport, stage, box ? box.getBoundingClientRect() : undefined)
  }
  // The legend closes on Esc and on a click anywhere else.
  const legendUp = () => !legendHidden && viewport.isConnected
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape' && legendUp()) { e.preventDefault(); showLegend(false) }
  }
  /** @param {PointerEvent} e */
  const onPointer = (e) => {
    const t = /** @type {Node} */ (e.target)
    if (legendUp() && !legend.contains(t) && !legendButton.contains(t)) showLegend(false)
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onPointer, true)

  // ---------- drawing ----------

  function draw() {
    world.textContent = ''
    drawn.nodeEls.clear()
    const { layout } = shown
    if (!layout) { world.append(el('p', 'gwait', shown.laying ? 'Laying out the map…' : '')); return }
    const acts = { isTutorialUp: () => host.isTutorialUp(), goStep: (n) => host.goStep(n), open: (t) => host.open(t), fitBox }
    const d = drawMap({ world, names, journey: shown.journey, byId: shown.byId, steps: stepsOf(shown.journey), layout, acts })
    drawn.nodeEls = d.nodeEls
    drawn.farNames = d.farNames
    drawn.measured = undefined
    drawn.ring = d.ring
    viewPlaced = false
    mark()
    host.rendered(shown.journey.nodes.length)
  }

  /** The current step: its box ringed, its number lit, its arrows drawn normally (the rest faint). */
  function mark() {
    const node = currentNode()
    markBoxes(world, names, drawn.nodeEls, node, currentHolder(node), shown.current)
    if (viewport.classList.contains('far')) farNames()
    if (shown.layout) markEdges(world, shown.layout, node)
  }

  /**
   * Far names (journey-farnames.js), never over each other: the current step's ring first, then most important
   * first (its block, systems, then blocks by size, then lone boxes). Nothing goes under the legend.
   */
  function farNames() {
    const { layout } = shown
    if (!layout || !drawn.ring) return
    if (!drawn.measured) drawn.measured = FarNames.measure(drawn.farNames)
    const taken = []
    if (!legend.hidden && legend.offsetParent) {
      const m = LEGEND_CLEARANCE
      taken.push({ x: legend.offsetLeft - m, y: legend.offsetTop - m, w: legend.offsetWidth + 2 * m, h: legend.offsetHeight + 2 * m })
    }
    const onScreen = (p) => ({ x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom, w: p.w * view.zoom, h: p.h * view.zoom })
    const node = currentNode()
    const ring = placeRing(node && layout.abs.get(node), onScreen)
    const holder = currentHolder(node)
    const items = drawn.measured.flatMap((name) => {
      const p = layout.abs.get(name.id)
      if (!p) return []
      return [{ name, blockRect: onScreen(p), isCurrentBlock: name.id === holder, rank: farRank(name.id, name.kind, node, holder), size: p.w * p.h }]
    })
    const { w, h } = port()
    FarNames.place(items, taken, ring, { x: 0, y: 0, w, h })
  }

  /** The ring around box `p` (world px; none: hidden), on screen through `onScreen`; returns its rectangle. */
  function placeRing(p, onScreen) {
    const ring = /** @type {HTMLElement} */ (drawn.ring)
    if (!p) { ring.style.display = 'none'; return undefined }
    const r = onScreen(p)
    const w = Math.max(RING_MIN, r.w + 2 * RING_MARGIN), h = Math.max(RING_MIN, r.h + 2 * RING_MARGIN)
    const rect = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
    ring.style.display = ''
    placeEl(ring, rect)
    return rect
  }

  /** Which far names are placed first (lowest first). */
  function farRank(id, kind, node, holder) {
    // The current step's box and the block holding it.
    if (id === holder || id === node) return 0
    // Systems, outer ones first.
    if (kind === 'outer') return 1 + ancestors(shown.byId, id).length / 100
    // Blocks of leaves.
    if (kind === 'inner') return 2
    // Lone boxes.
    return 3
  }

  // ---------- the view ----------

  function apply() {
    viewPlaced = true
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
    const far = view.zoom < FAR
    viewport.classList.toggle('far', far)
    names.hidden = !far
    if (far) farNames()
    placeLegendNow()
  }

  /** (x, y) kept in bounds at `zoom` (graph/view.js clampOffset). */
  function clamped(x, y, zoom) {
    if (!shown.layout) return { x, y }
    return clampOffset(x, y, zoom, shown.layout, port())
  }
  /** Moves the view to `target` (its zoom and offset kept in bounds), animated (MOVE_MS, eased out) or at once. */
  function moveView(target, animate) {
    const zoom = clampZoom(target.zoom)
    const c = clamped(target.x, target.y, zoom)
    cancelAnimationFrame(anim)
    if (!animate || reduced() || !viewport.isConnected) { Object.assign(view, { x: c.x, y: c.y, zoom }); apply(); return }
    const from = { ...view }, t0 = performance.now()
    const ease = (t) => 1 - Math.pow(1 - t, 3)
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / MOVE_MS), e = ease(t)
      // Zoom interpolated in log space, so it feels even.
      view.zoom = Math.exp(Math.log(from.zoom) + (Math.log(zoom) - Math.log(from.zoom)) * e)
      view.x = from.x + (c.x - from.x) * e
      view.y = from.y + (c.y - from.y) * e
      apply()
      if (t < 1) anim = requestAnimationFrame(tick)
    }
    anim = requestAnimationFrame(tick)
  }
  function zoomBy(f) { openFit = false; const p = port(); moveView(zoomedAt(view, f, p.w / 2, p.h / 2), true) }
  function fit(animate) {
    const { layout } = shown
    if (layout) moveView(showing({ x: 0, y: 0, w: layout.w, h: layout.h }, port(), FIT_MAX_ZOOM), animate)
  }
  function fitBox(id) {
    const p = shown.layout && shown.layout.abs.get(id)
    if (p) { openFit = false; moveView(showing(p, port(), SHOW_MAX_ZOOM), true) }
  }

  /**
   * The current step's box and its neighbourhood in view (graph/view.js following). A journey opens on the whole map
   * (a step's neighbourhood would cut the boxes at the view's edge) and keeps it over size changes until the walk or
   * the reader moves it. The tutorial keeps the view still, once it has one.
   */
  function follow(animate) {
    const { layout, journey } = shown
    if (!layout || !journey || (host.isTutorialUp() && viewPlaced)) return
    const node = currentNode()
    const stepMoved = followed !== shown.current
    openFit = followed === -1 || (openFit && !stepMoved)
    followed = shown.current
    const p = node && layout.abs.get(node)
    host.view(p ? node : '')
    if (!p || openFit) return fit(animate)
    moveView(following(p, neighbours(node), port()), animate)
  }

  /** The boxes (world px) around node `id`: those its arrows reach; none: the others in its module (its context,
   *  not one box in an empty frame). */
  function neighbours(id) {
    const { journey, layout, byId } = shown
    const at = (n) => layout?.abs.get(n)
    /** @type {import('./journey-layout.js').Rect[]} */
    const near = []
    for (const e of journey.edges) {
      const r = at(otherEnd(e, id))
      if (r) near.push(r)
    }
    if (near.length) return near
    const par = byId.get(id)?.parent
    for (const m of journey.nodes) {
      const r = par && m.parent === par && m.id !== id && at(m.id)
      if (r) near.push(r)
    }
    return near
  }

  listenForInput(viewport, {
    view: () => view,
    hasLayout: () => !!shown.layout,
    isTutorialUp: () => host.isTutorialUp(),
    clamped: (x, y) => clamped(x, y, view.zoom),
    jumpTo: (x, y) => { openFit = false; view.x = x; view.y = y; apply() },
    panTo: (x, y) => { openFit = false; moveView({ x, y, zoom: view.zoom }, true) },
    stopAnimation: () => cancelAnimationFrame(anim),
    zoomAt: (f, sx, sy) => { openFit = false; moveView(zoomedAt(view, f, sx, sy), false) },
    zoomBy,
    fit: () => fit(true),
  })

  // ---------- what the page calls ----------

  /** A journey (or the same one again) and where the walk is. */
  function set(j, current, legHidden) {
    legendHidden = legHidden
    paintLegendNow()
    const key = signature(j)
    const same = key === shown.layoutKey
    shown.journey = j
    shown.byId = new Map(j.nodes.map((n) => [n.id, n]))
    shown.current = current
    if (same) { if (shown.layout) { mark(); host.rendered(j.nodes.length) } return }
    shown.layoutKey = key
    const hit = keptLayout(key)
    if (hit) { shown.layout = hit; shown.laying = false; draw(); followed = -1; return }
    shown.layout = undefined
    shown.laying = true
    draw()
    layOut(j).then((r) => {
      keepLayout(key, r)
      if (shown.layoutKey !== key) return
      shown.layout = r
      shown.laying = false
      draw()
      followed = -1
      if (viewport.isConnected) { lastSize = port(); follow(false) }
    }).catch((e) => {
      shown.laying = false
      const why = e && e.message || e
      world.textContent = ''
      world.append(el('p', 'gwait', `The map could not be laid out: ${why}`))
      host.error(String(why))
    })
  }

  return {
    el: viewport,
    set,
    /** After the view is in the page: follow a new step (animated), or keep the view (a size change re-centres). */
    placed() {
      if (!shown.layout) return
      const size = port()
      const resized = !lastSize || size.w !== lastSize.w || size.h !== lastSize.h
      if (followed !== shown.current) { const smooth = followed !== -1 && !!lastSize; lastSize = size; follow(smooth) }
      else if (resized) { lastSize = size; follow(false) }
      else apply()
    },
    /**
     * The view changed width under the reader's hand (the splitter): what is on screen stays where it is (the map's
     * right edge is fixed); only if the current step's box would leave the view is it brought back.
     */
    resized() {
      const { layout } = shown
      if (!layout || !lastSize) return
      const dw = port().w - lastSize.w
      lastSize = port()
      const c = clamped(view.x + dw, view.y, view.zoom)
      view.x = c.x; view.y = c.y
      apply()
      const node = currentNode()
      const p = node && layout.abs.get(node)
      if (p) {
        const l = view.x + p.x * view.zoom, r = view.x + (p.x + p.w) * view.zoom
        if (l < 0 || r > port().w) follow(false)
      }
    },
    /** The map's document listeners removed (the page drops the map). */
    dispose() {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      cancelAnimationFrame(anim)
    },
  }
}

/** The node at edge `e`'s other end from `id` ('': `id` is at neither). */
function otherEnd(e, id) {
  if (e.from === id) return e.to
  if (e.to === id) return e.from
  return ''
}
