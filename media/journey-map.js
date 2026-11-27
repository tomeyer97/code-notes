// The journey panel (a webview): the page's script, bundled with what it imports as out/pages/map.js. Plain DOM + SVG.
// Layout: "‹ Journeys" (home: every journey, one click walks it), the question, one provenance line, then the
// storyline with the map beside it (wide) or above it (narrow, collapsible under "Map"). The map is the whole journey
// at once (journey-graph.js): pan, zoom, it follows the step; boxes open their code, step numbers walk to the step.
//
// This file wires the panel together: its state (map/state.js), the parts that draw it (map/header.js,
// map/storyline.js, the map, the step's animation in map/animation.js, the podcast's bar, the home, the tutorial, the
// splitter), the messages from the extension, render() and the startup. The parts get one panel context
// (map/context.js). Its messages both ways are src/protocol/map.ts: ToMap (one handler each, below) and FromMap.
import { el, connect, onMessages } from './common.js'
import { overflowing } from './report.js'
import { JourneyGraph } from './journey-graph.js'
import { JourneyHome } from './journey-home.js'
import { JourneySplitter, JourneyWidths, applyWidths } from './journey-splitter.js'
import { JourneyTutorial } from './journey-tutorial.js'
import { JourneyPodcast } from './journey-podcast.js'
import { createState, tourOf, snapshot, sceneOf } from './map/state.js'
import { md } from './map/markdown.js'
import { tutorialTarget } from './map/context.js'
import { makeHeader } from './map/header.js'
import { makeStoryline } from './map/storyline.js'
import { makeAnimation } from './map/animation.js'
import { makeScroll } from './map/scroll.js'
import { layout } from './map/layout.js'
import { routeKeys } from './map/keys.js'
import { runTestMessage } from './map/testHooks.js'

/** @typedef {import('../src/protocol/map').ToMap} ToMap */
/** @typedef {import('../src/protocol/map').FromMap} FromMap */

const { vscode, post } = /** @type {import('./types').Port<FromMap>} */ (connect())
const app = /** @type {HTMLElement} */ (document.getElementById('app'))
// The widths the stylesheet lays the panel out with, before anything is drawn.
applyWidths(document.documentElement)

const state = createState(vscode.getState() || {})
const { walk, view, anim, listen } = state

/** What the parts of the panel are given (map/context.js); the players are put in as they are made, below. */
const ctx = /** @type {import('./map/context.js').PanelContext} */ ({
  state, app, post, render, saveState, goStep, goHome, inEpisode,
  toggleAnim: () => animation.toggle(),
})

function saveState() {
  vscode.setState(snapshot(state))
}

// ---------- messages from the extension (src/protocol/map.ts ToMap), one handler each ----------

/** @type {import('./types').Handlers<ToMap>} */
const handlers = {
  journey(m) {
    const fresh = !walk.journey || walk.journey.id !== m.journey.id
    // Another journey starts at the top, its map in view: never the last one's scroll.
    if (fresh) {
      if (walk.journey) { view.savedScroll = 0; view.toTop = true }
      view.scrolled = ''
      anim.beatAt = {}
      home.set(false)
    }
    walk.journey = m.journey
    walk.deleted = ''
    takeTour(m)
    render()
  },
  tour(m) { takeTour(m); render() },
  home() { tutorial.close(); home.set(true); render() },
  hello() { post({ type: 'ready' }) },
  preview(m) { home.preview(m) },
  deleted(m) { walk.deleted = m.file || 'the file'; tutorial.close(); tutorial.hideOffer(); render() },
  tutorial() { tutorial.start() },
  // Ctrl+' P toggles the current step's animation; 'off' ends it.
  anim(m) {
    if (m.action === 'toggle') animation.toggle()
    else if (m.action === 'off' && anim.on) animation.toggle()
  },
  // The current beat's line and the lines around it, once the extension found them.
  code(m) { if (anim.on && m.n === walk.cur && m.i === animation.scene.beat) animation.scene.code(m.code) },
  podcast(m) { podcast.set(m.episode); render() },
  podcastState(m) { podcast.hostState(m) },
  podcastRole(m) { podcast.setRole(m) },
  podcastCmd(m) { podcast.cmd(m) },
  podcastBeat(m) { animation.podcastBeat(m) },
  test: runTestMessage,
}
onMessages(handlers)

/** A tour message: where the walk is, and what that resets. */
function takeTour(m) {
  // Never past the last step (the step you were on was removed).
  const steps = walk.journey ? walk.journey.steps.length : 0
  const was = walk.cur
  walk.cur = Math.min(m.current || 0, steps)
  const moved = !!walk.cur && walk.cur !== was
  // A step opened (D, a click in the code): the journey, not the list. The walk ended: back to the top.
  if (moved) home.set(false)
  if (!walk.cur && was) { view.toTop = true; view.scrolled = ''; anim.beatAt = {}; anim.on = false }
  walk.tour = tourOf(m, walk.cur)
  view.legendHidden = !!m.legendHidden
  if (!splitter.dragging) view.mapW = m.mapWidth || 0
  if (m.key) walk.key = m.key
  home.take(m)
  // The "New here?" bar: offered, or gone once the walk is under way.
  tutorial.onTour(!!m.tutorial, moved)
}

function goStep(n) {
  // The tutorial is a sandbox: a step clicked under it moves the tutorial on, not your place in the journey.
  if (tutorial.card || !walk.journey) return
  if (!walk.deleted && n >= 1 && n <= walk.journey.steps.length) post({ type: 'step', n })
}

// ---------- the parts of the panel ----------

/** The map: the whole journey at once, panned and zoomed (journey-graph.js). */
const graph = JourneyGraph({
  goStep,
  open: (path) => post({ type: 'openPath', path }),
  isTutorialUp: () => !!tutorial.card,
  legend: (hidden) => { view.legendHidden = hidden; post({ type: 'legend', hidden }) },
  rendered: (boxes) => post({ type: 'rendered', boxes }),
  view: (node) => post({ type: 'view', node }),
  error: (message) => post({ type: 'error', message }),
})

/** The step's animation (journey-scene.js, one player kept across renders). */
const animation = makeAnimation(ctx, { isHome: () => home.on })
ctx.scene = animation.scene

/** An episode is on: playing, or paused before its end. */
function inEpisode() {
  const ep = podcast && podcast.episode
  if (!ep || !walk.journey || podcast.now.ended) return false
  return listen.playing || listen.session === ep.key
}
/** The podcast's bar (journey-podcast.js), a remote of the Listen view's player. */
const podcast = JourneyPodcast({
  post,
  mode: 'remote',
  stepTitle: (n) => (walk.journey && walk.journey.steps[n - 1] ? walk.journey.steps[n - 1].title : ''),
  stepCount: () => (walk.journey ? walk.journey.steps.length : 0),
  keyPrefix: () => walk.key,
  onListening: (on) => {
    if (on === listen.playing) return
    listen.playing = on
    const ep = podcast && podcast.episode
    if (on && ep) listen.session = ep.key
    else if (!ep || podcast.now.ended) listen.session = ''
    document.body.classList.toggle('pod-on', on)
    if (walk.journey && !home.on) render()
    else saveState()
  },
  onTick: (t, _step, playing) => storyline.tick(t, playing),
})
ctx.podcast = podcast

/** Home: every journey, to find one and walk it (journey-home.js). */
const home = JourneyHome({
  app,
  post,
  render,
  walk: walkKey,
  hasJourney: () => !!walk.journey,
  isTutorialUp: () => !!tutorial.card,
})
function goHome() { if (!tutorial.card) home.open() }
function walkKey(k) {
  if (!k) return
  home.set(false)
  view.toTop = true
  post({ type: 'walk', key: k })
  render()
}

/** The tutorial: a few cards on the real panel (journey-tutorial.js). */
const tutorial = JourneyTutorial({ app, post, render, journey: () => walk.journey, isDeleted: () => !!walk.deleted })
ctx.tutorial = tutorial

/** The splitter: the map column's width (journey-splitter.js). */
const splitter = JourneySplitter(app, { onResize: () => graph.resized(), onKeep: keepWidth })
/** The width chosen: remembered here and by the extension (every panel, every journey); 0 resets to the default. */
function keepWidth(w) {
  view.mapW = w
  saveState()
  post({ type: 'mapWidth', w })
}

const header = makeHeader(ctx)
const storyline = makeStoryline(ctx)
const scroll = makeScroll(ctx)

/** The map's box, with the author's rule breaks under it. */
function mapBox() {
  const wrap = el('div', 'mapwrap')
  wrap.append(graph.el)
  if (walk.tour.authors && !walk.deleted) wrap.append(authorNote())
  return wrap
}

/** Rule breaks only the author can fix: a quiet link to the Output channel. */
function authorNote() {
  const { authors } = walk.tour
  const d = el('div', 'note')
  const a = el('button', 'link authors', `${authors} rule break${authors === 1 ? '' : 's'}`)
  a.title = 'In the Output panel'
  a.onclick = () => post({ type: 'authors' })
  d.append(a)
  return d
}

/** Narrow panels: "Map", which folds the map away (or back). */
function mapToggle(shown) {
  const t = el('button', 'link maptoggle', 'Map')
  t.setAttribute('aria-expanded', String(shown))
  t.title = shown ? 'Hide the map' : 'Show the map'
  t.onclick = () => { view.mapShut = !view.mapShut; render() }
  return t
}

/** The walk finished: one line and the summary (two sentences at most). The way to the others is the header's
 *  "‹ Journeys", right above (not a second one here). */
function doneView() {
  const summary = (walk.journey && walk.journey.summary) || ''
  const d = el('div', 'done')
  d.setAttribute('role', 'status')
  d.append(el('p', 'dtitle', 'Done'))
  const sentences = summary.match(/[^.!?]+[.!?]+(\s|$)/g)
  const two = sentences ? sentences.slice(0, 2).join('').trim() : summary.trim()
  if (two) { const p = el('p', 'dsum'); p.innerHTML = md(two); d.append(p) }
  return d
}

// ---------- render: the whole panel again from the state ----------

function render() {
  const j = walk.journey
  if (!j) return
  const keepY = beforeRender()
  app.textContent = ''
  storyline.reset()
  app.classList.toggle('deleted', !!walk.deleted)
  if (home.on) { home.draw(); saveState(); return }
  const episode = inEpisode()
  // Playing: the step's animation, or the map, alone (the same box every step); the rest comes back on pause. A panel
  // too narrow for the map's boxes keeps the chapter list (an empty box would be all there is).
  const boxOnly = episode && listen.playing && !walk.deleted && !tutorial.card && JourneyWidths.mapFits(app.clientWidth)
  document.body.classList.toggle('pod-map', boxOnly && !walk.cur)
  // No "New here?" while an episode is on (the walk's tutorial is not about listening).
  if (tutorial.offered && !tutorial.card && !walk.deleted && !episode) app.append(tutorial.bar())
  const head = tutorialTarget(el('div', 'head'), 'header')
  head.append(header.header())
  app.append(head)
  if (walk.tour.done && !walk.cur && !walk.deleted && !episode) app.append(doneView())
  const L = layout({
    panelW: app.clientWidth,
    animReady: anim.on && !!walk.cur && !!sceneOf(state, walk.cur),
    tutorialUp: !!tutorial.card,
    deleted: !!walk.deleted,
    mapShut: view.mapShut,
    hasSteps: j.steps.length > 0,
    boxOnly,
  })
  const body = el('div', boxOnly ? 'body pbox' : 'body')
  const m = L.shown ? tutorialTarget(L.anim ? animation.box() : mapBox(), 'map') : undefined
  animation.gone(L)
  if (boxOnly) {
    if (m) body.append(m)
    app.append(body)
    afterRender(body, head, m, L, 0)
    return
  }
  // The storyline leads: the map beside it (wide) or above it (narrow, foldable under "Map").
  const story = j.steps.length ? storyline.column() : el('p', 'note', 'This journey has no steps yet.')
  if (L.wide) {
    body.classList.add('wide')
    body.classList.toggle('anim', L.anim)
    body.append(story, ...(m ? [splitter.makeHandle(body, L.anim), m] : []))
  } else {
    if (L.hasMap && j.steps.length && !tutorial.card && !L.anim) body.append(mapToggle(L.shown))
    body.append(...(m ? [m] : []), story)
  }
  app.append(body)
  afterRender(body, head, m, L, keepY)
}

/** Before the panel is emptied: the keyboard and the scroll it keeps. Returns the scroll to go back to (0: none). */
function beforeRender() {
  // The home's search keeps the keyboard across a re-render (the list is drawn again under it); so do a row, a chip.
  home.beforeRender()
  animation.keepFocus()
  // A re-render keeps the scroll; the first render after a reload goes back to where it was.
  const keepY = view.toTop ? 0 : view.firstRender ? view.savedScroll : window.scrollY
  if (view.toTop) window.scrollTo(0, 0)
  view.toTop = false
  view.firstRender = false
  return keepY
}

/** Once the panel is in the page: the map column's width, the header's height, the map (or the scene) placed, the
 *  scroll back, the current row in view, the rows the voice is on, the report, the tutorial. */
function afterRender(body, head, m, L, keepY) {
  if (L.wide && m) splitter.widthTo(body, view.mapW, L.anim)
  scroll.headerDrawn(head)
  graph.set(walk.journey, walk.cur, view.legendHidden)
  if (m && !L.anim) graph.placed()
  if (m && L.anim) animation.place()
  if (keepY) window.scrollTo(0, keepY)
  view.savedScroll = 0
  scroll.follow()
  // Where the voice is, marked at once on the rows just drawn (not only at the next tick).
  listen.lastTick = ''
  if (podcast.episode) { const now = podcast.now; storyline.tick(now.t, now.playing) }
  if (listen.scrollToVoice) { listen.scrollToVoice = false; scroll.toVoice(L) }
  reportStory()
  saveState()
  tutorial.place()
}

/** What the storyline drew (for tests): its rows, the questions on it, anything cut or wider than the panel. */
function reportStory() {
  requestAnimationFrame(() => {
    const overflow = overflowing(app, '.story .st, .story .cp, .story .t', (e) => e.textContent.slice(0, 40))
    const { steps, stops, cur } = storyline.drawn
    post({ type: 'story', steps, stops, cur, overflow, width: document.documentElement.clientWidth })
  })
}

// ---------- startup ----------

/** The scroll is saved, and the panel's width reported, once it has not changed for this long (ms). */
const SCROLL_SAVE_MS = 300, WIDTH_REPORT_MS = 500
/** The size last rendered ({ w, h }) and the frame a re-layout waits for; the timers of the scroll and the width. */
let renderedSize
let relayoutFrame = 0, scrollTimer = 0, widthTimer = 0

// Re-lay out when the size changes, a frame later (rendering inside the observer would loop it).
const relayout = () => {
  cancelAnimationFrame(relayoutFrame)
  relayoutFrame = requestAnimationFrame(() => {
    const size = { w: app.clientWidth, h: window.innerHeight }
    const same = !!renderedSize && renderedSize.w === size.w && renderedSize.h === size.h
    if (walk.journey && !same) { renderedSize = size; render() }
  })
}
// The panel's width as the reader drags it: the extension keeps it for the next walk.
const reportWidth = () => {
  clearTimeout(widthTimer)
  widthTimer = window.setTimeout(() => post({ type: 'panelWidth', w: window.innerWidth }), WIDTH_REPORT_MS)
}
new ResizeObserver(relayout).observe(app)
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => { if (walk.journey) saveState() }, SCROLL_SAVE_MS)
})
window.addEventListener('resize', () => { relayout(); reportWidth() })
for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, scroll.readerScrolled, { passive: true })
// The keys: the tutorial's first while a card is up (the map and the home stay out of it on their own).
routeKeys([tutorial.onKey])
post({ type: 'ready' })
