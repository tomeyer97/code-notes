// Drawing the laid-out map (journey-graph.js calls drawMap on a new layout, markCurrent on every step): holders, the
// arrows, the leaves, the arrow labels and, for zoomed out, the far names; then the current step lit.
import { el, svgEl } from '../common.js'
import { ancestors, pathD, curveD } from '../journey-layout.js'
import { titleEl, leafEl } from './boxes.js'

/** An arrow's head (its marker's path, in an 8 × 8 box). */
const ARROW_HEAD = 'M0,0 L8,4 L0,8 z'

/** Text without its markdown marks (a tooltip shows them as they are). */
const plain = (s) => (s || '').replace(/`|\*\*/g, '')

/**
 * What the map's boxes do when clicked (journey-graph.js wires them to its host): a step number walks to the step,
 * a leaf opens its code, a holder zooms to itself; nothing while the tutorial is up.
 * @typedef {{ isTutorialUp(): boolean, goStep(n: number): void, open(target: string): void, fitBox(id: string): void }} BoxActions
 */
/**
 * One drawing: where (`world`: the scaled map, `names`: far names in screen space), what (the journey, its nodes by
 * id, its steps' numbers by node id, its layout), and what clicks do.
 * @typedef {{ world: HTMLElement, names: HTMLElement, journey: any, byId: Map<string, any>,
 *   steps: Map<string, number[]>, layout: import('../journey-layout.js').MapLayout, acts: BoxActions }} Drawing
 */

/** A box's tooltip: its name, its blurb, and (a leaf) where its code is. */
export function boxTitle(n, where = '') {
  return [n.label, plain(n.blurb || n.summary), where].filter(Boolean).join('\n')
}

/** Sets element `d`'s place and size to rectangle `p` (px). */
export function placeEl(d, p) {
  Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` })
}

/** Node `id` holds other boxes. */
const holds = (layout, id) => (layout.kids.get(id) || []).length > 0

/**
 * The whole map: holders first (outer ones under inner ones), then the arrows, then the leaves and the arrow labels;
 * the far names and the current step's ring in `names`. Returns the boxes' elements by id, the far names and the ring.
 * @param {Drawing} d
 */
export function drawMap(d) {
  const { world, names, journey, layout, byId } = d
  world.style.width = `${layout.w}px`
  world.style.height = `${layout.h}px`
  const depth = (id) => ancestors(byId, id).length
  const holders = journey.nodes.filter((n) => holds(layout, n.id)).sort((a, b) => depth(a.id) - depth(b.id))
  /** @type {Map<string, HTMLElement>} */
  const nodeEls = new Map()
  drawContainers(d, holders, depth, nodeEls)
  world.append(drawEdges(layout))
  drawLeaves(d, nodeEls)
  drawEdgeLabels(d)
  const farNames = drawFarNames(d, holders)
  // The current step's box, ringed in screen space (its own ring is too thin to see far out).
  const ring = el('div', 'gring')
  names.append(ring)
  return { nodeEls, farNames, ring }
}

/** The boxes that hold others (`holders`, outer first): a frame with its title; a click zooms to it. */
function drawContainers(d, holders, depth, nodeEls) {
  const { world, layout, acts } = d
  for (const n of holders) {
    const p = layout.abs.get(n.id)
    if (!p) continue
    const box = el('div', `gbox group ${n.kind} d${Math.min(depth(n.id), 2)}`)
    box.dataset.id = n.id
    placeEl(box, p)
    const t = titleEl(n)
    t.title = boxTitle(n)
    box.append(t)
    box.onclick = (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('.gnum')) return
      e.stopPropagation()
      if (!acts.isTutorialUp()) acts.fitBox(n.id)
    }
    world.append(box)
    nodeEls.set(n.id, box)
  }
}

/** The arrows, in one svg the map's size. @param {import('../journey-layout.js').MapLayout} layout */
function drawEdges(layout) {
  const svg = svgEl('svg', { class: 'gedges', width: layout.w, height: layout.h, viewBox: `0 0 ${layout.w} ${layout.h}` })
  svg.append(arrowHeads())
  for (const ed of layout.edges) {
    svg.append(svgEl('path', {
      d: ed.bez ? curveD(ed.bez) : pathD(ed.pts || []),
      class: `gedge${ed.e.async ? ' async' : ''}`,
      'marker-end': 'url(#garrow)',
      'data-from': ed.e.from,
      'data-to': ed.e.to,
      'data-i': ed.i,
    }))
  }
  return svg
}

/** The arrows' heads: `#garrow`, and `#garrow-on` for the current step's arrows. */
function arrowHeads() {
  const defs = svgEl('defs', {})
  for (const [id, cls] of [['garrow', 'gah'], ['garrow-on', 'gah on']]) {
    const box = { viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7 }
    const m = svgEl('marker', { id, ...box, orient: 'auto-start-reverse' })
    m.append(svgEl('path', { class: cls, d: ARROW_HEAD }))
    defs.append(m)
  }
  return defs
}

/** The boxes that hold none: name and step numbers; a click on a number walks to it, elsewhere opens the code. */
function drawLeaves(d, nodeEls) {
  const { world, journey, layout, steps, acts } = d
  for (const n of journey.nodes) {
    if (holds(layout, n.id)) continue
    const p = layout.abs.get(n.id)
    if (!p) continue
    const box = leafEl(n, steps.get(n.id) || [])
    box.dataset.id = n.id
    placeEl(box, p)
    box.title = boxTitle(n, n.at ? `${n.at.file}:${n.at.start}` : n.path || '')
    const target = openTarget(journey, n)
    if (!target) box.classList.add('inert')
    box.onclick = (e) => {
      e.stopPropagation()
      if (acts.isTutorialUp()) return
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.gnum'))
      if (b) return acts.goStep(Number(b.dataset.n))
      if (target) acts.open(target)
    }
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (box.querySelectorAll('.gnum'))) {
      const s = journey.steps[Number(b.dataset.n) - 1]
      if (s) b.title = `Step ${s.n}: ${s.title}`
    }
    world.append(box)
    nodeEls.set(n.id, box)
  }
}

/** What a leaf opens: its code (`at`), else its path, else its first step's lines. */
function openTarget(journey, n) {
  if (n.at) return `${n.at.file}:${n.at.start}-${n.at.end}`
  if (n.path) return n.path
  const s = journey.steps.find((x) => x.node === n.id)
  return s ? `${s.file}:${s.range.start}-${s.range.end}` : ''
}

/** Each arrow's label where the layout put it; the whole label and its detail in its tooltip when it says less. */
function drawEdgeLabels(d) {
  const { world, layout } = d
  for (const ed of layout.edges) {
    if (!ed.labelBox || !ed.text) continue
    const t = el('div', `glabel${ed.e.async ? ' async' : ''}`, ed.text)
    t.dataset.i = String(ed.i)
    Object.assign(t.style, { left: `${ed.labelBox.x}px`, top: `${ed.labelBox.y}px`, width: `${ed.labelBox.w}px` })
    const all = [ed.e.label, ed.e.detail].filter(Boolean)
    if (all.join('') !== ed.text) t.title = all.join('\n')
    world.append(t)
  }
}

/**
 * Far out, a box that holds only leaves becomes one quiet block (a `.gcover` over it) with its name and its step
 * numbers (no mush of tiny boxes); systems get their name; leaves no block covers (a record in a system, a top-level
 * box) get theirs too. journey-graph.js places them (journey-farnames.js). Returns them as data.
 * @param {Drawing} d @returns {import('../journey-farnames.js').FarName[]}
 */
function drawFarNames(d, holders) {
  const { world, names, journey, layout, steps } = d
  names.textContent = ''
  const out = []
  const covered = new Set()
  for (const n of holders) {
    const kids = layout.kids.get(n.id) || []
    const inner = kids.every((c) => !holds(layout, c.id))
    if (inner) {
      covered.add(n.id)
      const c = el('div', 'gcover')
      c.dataset.id = n.id
      placeEl(c, layout.abs.get(n.id))
      world.append(c)
    }
    const nums = inner ? kids.flatMap((c) => steps.get(c.id) || []).sort((a, b) => a - b) : []
    out.push(farNameEl(d, n, inner ? 'inner' : 'outer', nums))
  }
  for (const n of journey.nodes) {
    if (holds(layout, n.id) || covered.has(n.parent) || !layout.abs.get(n.id)) continue
    out.push(farNameEl(d, n, 'leaf', steps.get(n.id) || []))
  }
  return out
}

/** Node `n`'s far name, in `names`: its label and its step numbers (a click walks to one). */
function farNameEl(d, n, kind, nums) {
  const { names, journey, acts } = d
  const t = el('div', `gname ${kind} ${n.kind}`)
  t.dataset.id = n.id
  t.append(el('span', 'gnt', n.label))
  if (nums.length) {
    const s = el('div', 'gfnums')
    for (const v of nums) {
      const b = el('button', 'gfn', String(v))
      b.dataset.n = v
      b.tabIndex = -1
      const st = journey.steps[v - 1]
      if (st) b.title = `Step ${st.n}: ${st.title}`
      b.onclick = (e) => { e.stopPropagation(); if (!acts.isTutorialUp()) acts.goStep(v) }
      s.append(b)
    }
    t.append(s)
  }
  names.append(t)
  return { el: t, id: n.id, label: n.label, kind, nums }
}

/**
 * The current step lit (its node `node`, in block `holder`, number `current`; none: not walking): its box, its
 * block's cover and its numbers. markEdges does its arrows.
 */
export function markBoxes(world, names, nodeEls, node, holder, current) {
  for (const [id, d] of nodeEls) d.classList.toggle('current', id === node)
  const all = (root, sel) => /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(sel))
  for (const c of all(world, '.gcover')) c.classList.toggle('current', c.dataset.id === holder)
  for (const b of all(world, '.gnum')) b.classList.toggle('cur', Number(b.dataset.n) === current)
  for (const b of all(names, '.gfn')) b.classList.toggle('cur', Number(b.dataset.n) === current)
}

/** The current step's arrows drawn normally and on top, the rest faint (no step: all normal). */
export function markEdges(world, layout, node) {
  const on = (from, to) => !node || from === node || to === node
  for (const p of /** @type {NodeListOf<SVGElement>} */ (world.querySelectorAll('path.gedge'))) {
    const yes = on(p.dataset.from, p.dataset.to)
    p.classList.toggle('faint', !yes)
    p.classList.toggle('on', !!node && yes)
    p.setAttribute('marker-end', `url(#garrow${node && yes ? '-on' : ''})`)
  }
  for (const t of /** @type {NodeListOf<HTMLElement>} */ (world.querySelectorAll('.glabel'))) {
    const ed = layout.edges.find((x) => String(x.i) === t.dataset.i)
    if (ed) t.classList.toggle('faint', !on(ed.e.from, ed.e.to))
  }
  // On top: the current box's arrows over the faint ones.
  const svg = world.querySelector('svg.gedges')
  if (svg) for (const p of [...svg.querySelectorAll('path.gedge.on')]) svg.append(p)
}
