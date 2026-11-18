// The journey panel's tutorial: the "New here?" bar, then a few cards on the real panel, each pointing at one thing
// (the storyline, the card in the editor, its links, the animation, the map) with the rest dimmed. Needs common.js.
// Made by journey-map.js:
//   const t = JourneyTutorial({ app, post(m), render(), journey() (the one shown), isDeleted() })
//   t.card (0: no card up)  t.offered  t.start()  t.close()  t.dropOffer()  t.hideOffer()  t.onTour(offer, stepMoved)
//   t.bar() (the "New here?" bar)  t.place() (after a render: the current card, its ring and the dim)
// It posts { type: 'tutorial', action, card?, editor? } (journey-map.js's header lists the panel's messages).
;(function () {
  const { el, button, runKey, overlapArea } = window.common

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

  /** `{ x, y }`, `w` × `h` px, as { left, top, right, bottom }. */
  const rectAt = (o, w, h) => ({ left: o.x, top: o.y, right: o.x + w, bottom: o.y + h })

  window.JourneyTutorial = function ({ app, post, render, journey, isDeleted }) {
    /** The bar is offered ("New here?"); the card shown (0: none). */
    let offer = false
    let tcard = 0
    /** The bar was dropped in this panel (skipped, or the walk got going): never offered again here. */
    let offerGone = false
    /** Steps walked since the bar was offered (at two it goes). */
    let offerSteps = 0
    /** The tutorial's elements on the page: the ring, the card, the dim. */
    let spot, tc, dim

    /** The tutorial's message to the extension: 'bar' (offered), 'card' (shown: `card`, and what the editor shows,
     *  `editor`), 'skip' (declined, or left before the end), 'done' (its last card's Done). */
    const tell = (action, extra) => post({ type: 'tutorial', action, ...extra })

    // ---------- what the cards point at ----------

    const storyline = () => app.querySelector('.story')
    const currentRow = () => app.querySelector('.story .st.cur') || storyline()
    const animButton = () => app.querySelector('.story .animbtn') || currentRow()
    const mapPane = () => app.querySelector('.mapwrap')

    /** The cards: what each one points at, and what it says. A card with nothing to point at is skipped. The two
     *  about the card in the editor point at the current row here; the extension opens a step there and boxes its
     *  lines (`editor`). */
    function cards() {
      const J = journey()
      const noSteps = !J.steps.length
      const anims = J.steps.some((x) => x.scene)
      const tints = J.steps.some((x) => x.links && x.links.length)
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

    /** The current card: the dim with a hole around what it points at, a ring in the hole, the card next to it. */
    function place() {
      spot?.remove(); tc?.remove(); dim?.remove(); spot = tc = dim = undefined
      if (!tcard) return
      const cs = cards()
      const c = cs[tcard - 1]
      const target = c.target()
      if (!target) return
      // The card first (hidden), to know its size before choosing where things go.
      const { card, next } = buildCard(cs, c)
      tc = card
      tc.style.visibility = 'hidden'
      document.body.append(tc)
      const W = document.documentElement.clientWidth, H = window.innerHeight
      const cw = Math.min(CARD_W, W - 2 * EDGE)
      tc.style.width = `${cw}px`
      const ch = tc.offsetHeight
      // What scrolls goes below the sticky header, never under it; the target and the card both in view.
      const head = app.querySelector('.head')
      const inHead = !!head && head.contains(target)
      const top0 = inHead || !head ? 0 : head.getBoundingClientRect().bottom
      const box = { W, H, cw, ch }
      const R = scrollIntoRoom(target, inHead, top0, box)
      const sx = window.scrollX, sy = window.scrollY
      dimAround(R, sx, sy)
      // Next to the element, never over it, never over the header, and over as little else as possible (R6).
      const at = bestSpot(R, target, (inHead ? 0 : top0) + MARGIN, box)
      tc.style.left = `${at.x + sx}px`
      tc.style.top = `${at.y + sy}px`
      tc.style.visibility = ''
      ;(next || target).focus({ preventScroll: true })
    }

    /** Card `c` of `cs`: its text, the dots (where you are), Skip / Back / Next (Done on the last). */
    function buildCard(cs, c) {
      const card = el('div', 'tcard')
      card.setAttribute('role', 'dialog')
      const live = cs.filter((x) => !x.skip)
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

    /** Scrolls `target` into view with room for the card (ch high, cw wide; the panel W × H) below the header (its
     *  bottom at top0), and returns its visible rectangle (viewport px): of a target taller than the room, its top part. */
    function scrollIntoRoom(target, inHead, top0, { W, H, cw, ch }) {
      // Room for the card below rectangle q, above it, or beside it.
      const fitsBelow = (q) => q.bottom + GAP + ch + GAP <= H
      const fitsAbove = (q) => q.top - GAP - ch - GAP >= top0
      const fitsBeside = (q) => Math.max(W - q.right, q.left) >= cw + 2 * GAP
      const room = (q) => fitsBelow(q) || fitsAbove(q) || fitsBeside(q)
      let r = target.getBoundingClientRect()
      const outOfView = r.top < top0 + PAD || r.bottom > H - PAD
      if (!inHead && (outOfView || !room(r))) {
        // Both fit under the header: the target and the card centred in the room; else the target at its top.
        const free = H - top0
        const bothFit = r.height + GAP + ch + 2 * GAP <= free
        const want = bothFit ? top0 + Math.max(GAP, (free - r.height - GAP - ch) / 2) : top0 + GAP
        window.scrollBy(0, r.top - want)
        r = target.getBoundingClientRect()
      }
      // A target taller than the room (the storyline on a short panel): its visible top part, the card under it.
      const R = { left: r.left, right: r.right, top: Math.max(r.top, top0 + PAD), bottom: Math.min(r.bottom, H - PAD) }
      if (!room(R)) R.bottom = Math.max(R.top + TARGET_MIN_H, H - 2 * GAP - ch - PAD)
      return R
    }

    /** The dim over the whole page with a hole at R (viewport px), and the ring in the hole. One layer with a clip-path
     *  (a huge box-shadow is not always painted everywhere). */
    function dimAround(R, sx, sy) {
      const de = document.documentElement
      // The hole (page px): R and the ring's padding.
      const x1 = R.left + sx - PAD, y1 = R.top + sy - PAD, x2 = R.right + sx + PAD, y2 = R.bottom + sy + PAD
      spot = el('div', 'spot')
      Object.assign(spot.style, {
        left: `${x1}px`,
        top: `${y1}px`,
        width: `${R.right - R.left + 2 * PAD}px`,
        height: `${R.bottom - R.top + 2 * PAD}px`,
      })
      dim = el('div', 'tdim')
      // The page's size: the dim covers all of it but the hole (the even-odd rule cuts the second square out).
      const PW = Math.max(de.scrollWidth, de.clientWidth), PH = Math.max(de.scrollHeight, window.innerHeight)
      Object.assign(dim.style, { width: `${PW}px`, height: `${PH}px` })
      const page = ['0 0', `${PW}px 0`, `${PW}px ${PH}px`, `0 ${PH}px`, '0 0']
      const hole = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(([x, y]) => `${x}px ${y}px`)
      dim.style.clipPath = `polygon(evenodd, ${[...page, ...hole].join(', ')})`
      document.body.insertBefore(dim, tc)
      document.body.insertBefore(spot, tc)
    }

    /** Where the card goes (viewport px, its top left): of the places beside R that fit on screen (below minY), the one
     *  that covers least of what matters (never R itself if anything else fits); none fits: under R, kept on screen. */
    function bestSpot(R, target, minY, { W, H, cw, ch }) {
      const clampX = (v) => Math.max(EDGE, Math.min(v, W - cw - EDGE))
      const clampY = (v) => Math.max(minY, Math.min(v, H - ch - BOTTOM))
      const below = R.bottom + GAP, above = R.top - GAP - ch
      const candidates = [
        { x: clampX(R.left), y: below }, // below, left-aligned
        { x: clampX(R.right - cw), y: below }, // below, right-aligned
        { x: clampX(R.left), y: above }, // above, left-aligned
        { x: clampX(R.right - cw), y: above }, // above, right-aligned
        { x: R.right + GAP, y: clampY(R.top) }, // to the right
        { x: R.left - GAP - cw, y: clampY(R.top) }, // to the left
        { x: clampX(W - cw - EDGE), y: below }, // below, at the right edge
        { x: EDGE, y: below }, // below, at the left edge
      ]
      const onScreen = (o) => o.x >= EDGE && o.x + cw <= W - EDGE && o.y >= minY && o.y + ch <= H - MARGIN
      const fits = candidates.filter(onScreen)
      if (!fits.length) return { x: clampX(R.left), y: clampY(R.bottom + GAP) }
      // What the card should not cover (besides the target): the map most of all, the storyline, the title, the header.
      const avoid = [...app.querySelectorAll('.mapwrap, .story, h1.q, .prov, .tour')]
        .filter((e) => e !== target && !e.contains(target) && !target.contains(e))
        .map((e) => {
          const q = e.getBoundingClientRect()
          const weight = e.classList.contains('mapwrap') ? MAP_WEIGHT : 1
          return { left: q.left, right: q.right, top: q.top, bottom: q.bottom, weight }
        })
      const ring = { left: R.left - PAD, right: R.right + PAD, top: R.top - PAD, bottom: R.bottom + PAD }
      const covered = (o, q) => overlapArea(rectAt(o, cw, ch), q)
      const score = (o) => {
        const onTarget = covered(o, ring) > 0 ? ON_TARGET : 0
        return onTarget + avoid.reduce((sum, q) => sum + covered(o, q) * q.weight, 0)
      }
      return fits.reduce((b, o) => (score(o) < score(b) ? o : b))
    }

    // While a card is up: Esc leaves, → (or Enter, but on a button or box: its own click) goes on, ← back.
    document.addEventListener('keydown', (e) => {
      if (!tcard) return
      runKey(e, {
        Escape: () => end('skip'),
        ArrowRight: () => move(1),
        Enter: !e.target.closest?.('button, .box') && (() => move(1)),
        ArrowLeft: () => move(-1),
      })
    })

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
    }
  }
})()
