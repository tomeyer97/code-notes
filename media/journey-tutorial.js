// The journey panel's tutorial: the "New here?" bar, then a few cards on the real panel, each pointing at one thing
// (the storyline, the card in the editor, its links, the animation, the map) with the rest dimmed. Styles in
// journey-tutorial.css.
// Made by journey-map.js:
//   const t = JourneyTutorial(host)   (host: TutorialHost below)
//   t.card (0: no card up)  t.offered  t.start()  t.close()  t.dropOffer()  t.hideOffer()  t.onTour(offer, stepMoved)
//   t.bar() (the "New here?" bar)  t.place() (after a render: the current card, its ring and the dim)
//   t.onKey(e) (the panel's key router: the keys while a card is up)
// What the cards point at, the panel marks where it builds it: data-tutorial="<name>" (TARGETS).
// It posts { type: 'tutorial', action, card?, editor? } (src/protocol/map.ts FromMap has the panel's messages).
import { el, button, runKey, overlapArea } from './common.js'
import { placeLeastCovering } from './placement.js'

/** The space between the card and what it points at, around the screen's edges (GAP); the ring's padding (PAD). */
const GAP = 10, PAD = 4
/** The card's widest (px) and its margin from the panel's sides. */
const CARD_W = 320, EDGE = 12
/** How close (px) the card may come to the header above it and to the window's bottom; when no place fits and it
 *  is only kept on screen, BOTTOM above the bottom. */
const MARGIN = 4, BOTTOM = 8
/** A target taller than the room: at least this much of it (px) stays above the card. */
const TARGET_MIN_H = 40
/** In the scoring of the card's places: covering what it points at is never chosen if anything else fits, and
 *  covering the map counts this many times its area (the rest once). */
const ON_TARGET = 1e9, MAP_WEIGHT = 1e4

/** What the panel marks with data-tutorial: the parts the cards point at, and what a card should not cover. */
export const TARGETS = {
  storyline: 'storyline',
  currentRow: 'current-row',
  animation: 'animation',
  map: 'map',
  header: 'header',
  title: 'title',
  byline: 'byline',
  controls: 'controls',
}
/** What the card should not cover (besides what it points at): the map most of all, the storyline, the header's. */
const AVOID = [TARGETS.map, TARGETS.storyline, TARGETS.title, TARGETS.byline, TARGETS.controls]

/** What each card says (one thing per card, plain sentences; what only some journeys have is said only there). */
const CARD_TEXT = {
  storyline: 'The steps, in the order things happen. Click one to see its code.',
  editorCard: 'In the editor, the card above the code explains the step. Highlighted there now: Next, Ask and More.',
  links: 'The phrases highlighted in that card now are links. Click one to see the code that does it.',
  animation: '"Show animation" plays the step beat by beat in place of the map. ' +
    'Each beat shows the line of code that does it.',
  map: 'Where each step happens; the numbers are the steps, click one to go there. ' +
    'Drag to move, Ctrl+wheel to zoom.',
}

/** The card at `{ x, y }`, `w` × `h` px, as { left, top, right, bottom } (and where it is). */
const cardAt = (o, w, h) => ({ ...o, left: o.x, top: o.y, right: o.x + w, bottom: o.y + h })

/**
 * @typedef {object} TutorialHost
 * @property {HTMLElement} app the panel's element
 * @property {(m: import('../src/protocol/map').FromMap) => void} post
 * @property {() => void} render the panel again
 * @property {() => import('../src/core/format/journeyModel').Journey | undefined} journey the one shown
 * @property {() => boolean} isDeleted its file is gone
 */

/**
 * @typedef {object} Room where the card may go: the window (W × H px) below the sticky header (`top`), and the card's
 *  size (`cardW` × `cardH`)
 * @property {number} W
 * @property {number} H
 * @property {number} top
 * @property {number} cardW
 * @property {number} cardH
 */

/** @param {TutorialHost} host */
export function JourneyTutorial({ app, post, render, journey, isDeleted }) {
  /** The bar is offered ("New here?"); the card shown (0: none). */
  let offer = false
  let tcard = 0
  /** The bar was dropped in this panel (skipped, or the walk got going): never offered again here. */
  let offerGone = false
  /** Steps walked since the bar was offered (at two it goes). */
  let offerSteps = 0
  /** The tutorial's elements on the page: the ring, the card, the dim. The card stays while it is the same card. */
  let spot, tc, dim
  /** The card on the page: which one, of how many, and where everything was when it was placed. */
  let placed = { card: 0, of: 0, at: '' }

  /** The tutorial's message to the extension: 'bar' (offered), 'card' (shown: `card`, and what the editor shows,
   *  `editor`), 'skip' (declined, or left before the end), 'done' (its last card's Done). */
  const tell = (action, extra) => post({ type: 'tutorial', action, ...extra })

  // ---------- what the cards point at ----------

  const marked = (name) => /** @type {HTMLElement | null} */ (app.querySelector(`[data-tutorial="${name}"]`))
  const storyline = () => marked(TARGETS.storyline)
  const currentRow = () => marked(TARGETS.currentRow) || storyline()
  const animButton = () => marked(TARGETS.animation) || currentRow()
  const mapPane = () => marked(TARGETS.map)

  /** The cards: what each one points at, and what it says. A card with nothing to point at is skipped. The two
   *  about the card in the editor point at the current row here; the extension opens a step there and boxes its
   *  lines (`editor`). */
  function cards() {
    const j = /** @type {import('../src/core/format/journeyModel').Journey} */ (journey())
    const noSteps = !j.steps.length
    const anims = j.steps.some((x) => x.scene)
    const tints = j.steps.some((x) => x.links && x.links.length)
    return [
      { target: storyline, text: CARD_TEXT.storyline, skip: noSteps },
      { target: currentRow, text: CARD_TEXT.editorCard, skip: noSteps, editor: 'card' },
      { target: currentRow, text: CARD_TEXT.links, skip: noSteps || !tints, editor: 'links' },
      { target: animButton, text: CARD_TEXT.animation, skip: noSteps || !anims },
      { target: mapPane, text: CARD_TEXT.map, skip: !mapPane() },
    ]
  }

  // ---------- the bar, and moving through the cards ----------

  function dropOffer() {
    if (!offer) return
    offer = false
    offerGone = true
    tell('skip')
  }

  /** A tour message: `offerIt` (the extension offers the bar) and whether the walk moved to another step. The
   *  bar goes once the walk is under way: two steps on, as if skipped. */
  function onTour(offerIt, stepMoved) {
    if (stepMoved && offer && ++offerSteps >= 2) dropOffer()
    if (offerIt && !offer && !tcard && !offerGone) {
      offer = true
      offerSteps = 0
      tell('bar')
    }
    if (!offerIt) offer = false
  }

  function bar() {
    const b = el('div', 'tbar')
    b.append(el('span', 'tq', 'New here?'))
    const go = el('button', 'link tstart', 'Show me how')
    go.onclick = () => start()
    const skip = el('button', 'link tskip', 'Skip')
    skip.onclick = () => { dropOffer(); render() }
    b.append(go, el('span', 'sep', '·'), skip)
    return b
  }

  function start() {
    if (!journey() || isDeleted()) return
    offer = false
    tcard = 1
    render()
    // The first card that has something to point at.
    const first = cards()[0]
    if (first.skip) move(1)
    else tell('card', { card: 1, editor: first.editor || false })
  }

  function move(d) {
    const cs = cards()
    let n = tcard + d
    while (n >= 1 && n <= cs.length && cs[n - 1].skip) n += d
    if (n < 1) return
    if (n > cs.length) return end('done')
    tcard = n
    tell('card', { card: n, editor: cs[n - 1].editor || false })
    render()
  }
  /** The tutorial ends: 'skip' (left before its end) or 'done'. */
  function end(action) {
    tcard = 0
    tell(action)
    render()
  }

  // ---------- the current card on the page ----------

  function removeAll() {
    spot?.remove(); tc?.remove(); dim?.remove()
    spot = tc = dim = undefined
    placed = { card: 0, of: 0, at: '' }
  }

  /** The current card: the dim with a hole around what it points at, a ring in the hole, the card next to it. Kept
   *  as it is while nothing it is placed by moved (a render for a podcast tick moves neither scroll nor focus). */
  function place() {
    if (!tcard) return removeAll()
    const cs = cards()
    const c = cs[tcard - 1]
    const target = c.target()
    if (!target) return removeAll()
    const live = cs.filter((x) => !x.skip)
    const at = whereThingsAre(target)
    if (tc && placed.card === tcard && placed.of === live.length && placed.at === at) return
    // The card first (hidden), to know its size before choosing where things go; a new one only for another card.
    /** A new card takes the keyboard (on its Next); the same card moved keeps it where it is. */
    let focusOn
    if (!tc || placed.card !== tcard || placed.of !== live.length) {
      tc?.remove()
      const built = buildCard(cs, c, live)
      tc = built.card
      document.body.append(tc)
      focusOn = built.next
    }
    const card = /** @type {HTMLElement} */ (tc)
    card.style.visibility = 'hidden'
    const W = document.documentElement.clientWidth, H = window.innerHeight
    const cardW = Math.min(CARD_W, W - 2 * EDGE)
    card.style.width = `${cardW}px`
    // What scrolls goes below the sticky header, never under it; the target and the card both in view.
    const head = marked(TARGETS.header)
    const inHead = !!head && head.contains(target)
    const room = { W, H, cardW, cardH: card.offsetHeight, top: inHead || !head ? 0 : head.getBoundingClientRect().bottom }
    if (!inHead) scrollTargetIntoRoom(target, room)
    const visibleTarget = visibleRect(target, room)
    const sx = window.scrollX, sy = window.scrollY
    dimAround(visibleTarget, sx, sy)
    // Next to the element, never over it, never over the header, and over as little else as possible.
    const spotAt = bestSpot(visibleTarget, target, (inHead ? 0 : room.top) + MARGIN, room)
    card.style.left = `${spotAt.x + sx}px`
    card.style.top = `${spotAt.y + sy}px`
    card.style.visibility = ''
    placed = { card: tcard, of: live.length, at: whereThingsAre(target) }
    focusOn?.focus({ preventScroll: true })
  }

  /** Everything a card's place depends on: the target's rectangle, the window, the scroll, the page's size. */
  function whereThingsAre(target) {
    const r = target.getBoundingClientRect(), de = document.documentElement
    return [r.left, r.top, r.right, r.bottom, de.clientWidth, window.innerHeight, window.scrollX, window.scrollY, de.scrollWidth, de.scrollHeight].map(Math.round).join()
  }

  /** Card `c` of `cs` (`live`: those not skipped): its text, the dots (where you are), Skip / Back / Next (Done on
   *  the last). */
  function buildCard(cs, c, live) {
    const card = el('div', 'tcard')
    card.setAttribute('role', 'dialog')
    const at = live.indexOf(c)
    card.setAttribute('aria-label', `Tutorial ${at + 1} of ${live.length}`)
    card.append(el('p', 'ttext', c.text))
    const foot = el('div', 'tfoot')
    // Dots only: where you are, no "1/6" beside them.
    const dots = el('span', 'dots')
    dots.setAttribute('aria-hidden', 'true')
    dots.textContent = live.map((x) => (cs.indexOf(x) < tcard ? '●' : '○')).join(' ')
    foot.append(dots)
    const nav = el('span', 'tnav')
    // The last card: no Skip (Esc leaves); Done finishes.
    const last = at === live.length - 1
    if (!last) {
      const x = button('link tclose', 'Skip', () => end('skip'))
      x.title = 'Leave the tutorial (Esc)'
      nav.append(x)
    }
    if (at > 0) nav.append(button('link tback', 'Back', () => move(-1)))
    const next = button('btn tnext', last ? 'Done' : 'Next', () => move(1))
    nav.append(next)
    foot.append(nav)
    card.append(foot)
    return { card, next }
  }

  /** Room for the card below rectangle q, above it, or beside it. */
  function hasRoom(q, { W, H, cardW, cardH, top }) {
    const below = q.bottom + GAP + cardH + GAP <= H
    const above = q.top - GAP - cardH - GAP >= top
    const beside = Math.max(W - q.right, q.left) >= cardW + 2 * GAP
    return below || above || beside
  }

  /** Scrolls `target` into view with room for the card below the header, when it is out of view or there is no room
   *  around it: the target and the card centred in the room when both fit, else the target at its top. */
  function scrollTargetIntoRoom(target, room) {
    const r = target.getBoundingClientRect()
    const outOfView = r.top < room.top + PAD || r.bottom > room.H - PAD
    if (!outOfView && hasRoom(r, room)) return
    const free = room.H - room.top
    const bothFit = r.height + GAP + room.cardH + 2 * GAP <= free
    const want = bothFit ? room.top + Math.max(GAP, (free - r.height - GAP - room.cardH) / 2) : room.top + GAP
    window.scrollBy(0, r.top - want)
  }

  /** What shows of `target` (viewport px) below the header: of a target taller than the room (the storyline on a
   *  short panel), its top part, the card under it. */
  function visibleRect(target, room) {
    const r = target.getBoundingClientRect()
    const shown = { left: r.left, right: r.right, top: Math.max(r.top, room.top + PAD), bottom: Math.min(r.bottom, room.H - PAD) }
    if (!hasRoom(shown, room)) shown.bottom = Math.max(shown.top + TARGET_MIN_H, room.H - 2 * GAP - room.cardH - PAD)
    return shown
  }

  /** The dim over the whole page with a hole at `hole` (viewport px), and the ring in the hole. One layer with a
   *  clip-path (a huge box-shadow is not always painted everywhere). */
  function dimAround(hole, sx, sy) {
    spot?.remove(); dim?.remove()
    const de = document.documentElement
    // The hole (page px): the target and the ring's padding.
    const x1 = hole.left + sx - PAD, y1 = hole.top + sy - PAD, x2 = hole.right + sx + PAD, y2 = hole.bottom + sy + PAD
    spot = el('div', 'spot')
    Object.assign(spot.style, {
      left: `${x1}px`,
      top: `${y1}px`,
      width: `${hole.right - hole.left + 2 * PAD}px`,
      height: `${hole.bottom - hole.top + 2 * PAD}px`,
    })
    dim = el('div', 'tdim')
    // The page's size: the dim covers all of it but the hole (the even-odd rule cuts the second square out).
    const PW = Math.max(de.scrollWidth, de.clientWidth), PH = Math.max(de.scrollHeight, window.innerHeight)
    Object.assign(dim.style, { width: `${PW}px`, height: `${PH}px` })
    const page = ['0 0', `${PW}px 0`, `${PW}px ${PH}px`, `0 ${PH}px`, '0 0']
    const holePath = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(([x, y]) => `${x}px ${y}px`)
    dim.style.clipPath = `polygon(evenodd, ${[...page, ...holePath].join(', ')})`
    document.body.insertBefore(dim, tc || null)
    document.body.insertBefore(spot, tc || null)
  }

  /** Where the card goes (viewport px, its top left): of the places beside `t` that fit on screen (below minY), the
   *  one that covers least of what matters (never `t` itself if anything else fits); none fits: under `t`, kept on
   *  screen. */
  function bestSpot(t, target, minY, { W, H, cardW, cardH }) {
    const clampX = (v) => Math.max(EDGE, Math.min(v, W - cardW - EDGE))
    const clampY = (v) => Math.max(minY, Math.min(v, H - cardH - BOTTOM))
    const below = t.bottom + GAP, above = t.top - GAP - cardH
    const candidates = [
      { x: clampX(t.left), y: below }, // below, left-aligned
      { x: clampX(t.right - cardW), y: below }, // below, right-aligned
      { x: clampX(t.left), y: above }, // above, left-aligned
      { x: clampX(t.right - cardW), y: above }, // above, right-aligned
      { x: t.right + GAP, y: clampY(t.top) }, // to the right
      { x: t.left - GAP - cardW, y: clampY(t.top) }, // to the left
      { x: clampX(W - cardW - EDGE), y: below }, // below, at the right edge
      { x: EDGE, y: below }, // below, at the left edge
    ]
    const onScreen = (o) => o.x >= EDGE && o.x + cardW <= W - EDGE && o.y >= minY && o.y + cardH <= H - MARGIN
    const fits = candidates.filter(onScreen).map((o) => cardAt(o, cardW, cardH))
    const avoid = AVOID.flatMap((name) => [...app.querySelectorAll(`[data-tutorial="${name}"]`)])
      .filter((e) => e !== target && !e.contains(target) && !target.contains(e))
      .map((e) => {
        const q = e.getBoundingClientRect()
        const weight = /** @type {HTMLElement} */ (e).dataset.tutorial === TARGETS.map ? MAP_WEIGHT : 1
        return { left: q.left, right: q.right, top: q.top, bottom: q.bottom, weight }
      })
    const ring = { left: t.left - PAD, right: t.right + PAD, top: t.top - PAD, bottom: t.bottom + PAD }
    const best = placeLeastCovering(fits, avoid, { cost: (c) => (overlapArea(c, ring) > 0 ? ON_TARGET : 0) })
    return best || { x: clampX(t.left), y: clampY(t.bottom + GAP) }
  }

  /** While a card is up it owns the keys: Esc leaves, → (or Enter, but on a button or box: its own click) goes on,
   *  ← back. Returns whether it owned the key. */
  function onKey(e) {
    if (!tcard) return false
    runKey(e, {
      Escape: () => end('skip'),
      ArrowRight: () => move(1),
      Enter: !/** @type {HTMLElement} */ (e.target).closest?.('button, .box') && (() => move(1)),
      ArrowLeft: () => move(-1),
    })
    return true
  }

  return {
    /** The card shown (1-based), 0: none. */
    get card() { return tcard },
    /** The "New here?" bar is offered. */
    get offered() { return offer },
    start,
    /** No card any more (the panel shows something else), nothing said. */
    close() { tcard = 0 },
    dropOffer,
    /** The bar is not shown (the journey was deleted); it may be offered again. */
    hideOffer() { offer = false },
    onTour,
    bar,
    place,
    onKey,
  }
}
