// The journey's whole map at once, as a view: the boxes and arrows where journey-layout.js put them (cached per
// journey), far names when zoomed out (journey-farnames.js), pan (drag, wheel), zoom (Ctrl+wheel, + − Fit, keys), and
// it follows the step: the current step's box centred at a readable zoom, ringed. Function boxes carry their step
// numbers. Needs common.js, journey-layout.js and journey-farnames.js, loaded before it.
// API: const g = JourneyGraph({ goStep(n), open(path), isTutorialUp() (nothing moves, nothing opens), legend(hidden),
//        rendered(boxes), view(node), error(message) })
//      g.el (the viewport, re-appended on every render)  g.set(J, cur, legendHidden)  g.placed()  g.resized()
;(function () {
  const { el, svgEl, runKey, between } = window.common
  const { layout, signature, stepsOf, ancestors, titleEl, leafEl, pathD, curveD } = window.JourneyLayout
  const FarNames = window.JourneyFarNames
  const plain = (s) => (s || '').replace(/`|\*\*/g, '')
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /** Zoom bounds; below FAR the leaves' text and the arrow labels are hidden (too small to read), titles stay. */
  const KMIN = 0.12, KMAX = 2.5, FAR = 0.55, READ = 0.8
  /** One step of + and − (the buttons and the keys). */
  const ZOOM_STEP = 1.25
  /** An arrow's head (its marker's path, in an 8 × 8 box). */
  const ARROW_HEAD = 'M0,0 L8,4 L0,8 z'
  /** Layouts by journey content (a tour message never lays out again; an edited journey does once). */
  const cache = new Map()

  window.JourneyGraph = function (host) {
    const view = el('div', 'gmap')
    view.tabIndex = 0
    view.setAttribute('role', 'group')
    view.setAttribute('aria-label', 'Map. Drag to move, Ctrl+wheel to zoom, 0 fits.')
    // The drawing: the controls sit in a row under it, never over anything drawn.
    const stage = el('div', 'gstage')
    view.append(stage)
    const world = el('div', 'gworld')
    stage.append(world)
    /** Far out: the names, at a size you can read, over the boxes (screen space, not scaled). */
    const names = el('div', 'gnames')
    names.setAttribute('aria-hidden', 'true')
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
    const q = btn('glegq', '?', 'What the map shows', () => showLegend(legendHidden))
    view.append(ctl)
    const leg = el('div', 'glegend')
    view.append(leg)
    function showLegend(on) { legendHidden = !on; host.legend(legendHidden); paintLegend() }
    // The legend closes on Esc and on a click anywhere else.
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !legendHidden && view.isConnected) { e.preventDefault(); showLegend(false) } })
    document.addEventListener('pointerdown', (e) => { if (!legendHidden && view.isConnected && !leg.contains(e.target) && !q.contains(e.target)) showLegend(false) }, true)

    let J, cur = 0, legendHidden = true, sig = '', L, laying = false
    /** The journey's nodes by id. */
    let byId = new Map()
    /** Far out: each name's measured variants (farMeasure), and the current step's ring. */
    let farM, ring
    /** The view: screen = world * k + (x, y). */
    let x = 0, y = 0, k = 1
    let anim = 0
    /** The step the map last followed: a new one moves it (also back from wherever it was dragged). */
    let followed = -1
    const nodeEls = new Map()

    /** The current step's node (undefined: not walking). */
    const currentNode = () => (cur ? J?.steps[cur - 1]?.node : undefined)
    /** How many boxes hold node `id`. */
    const depth = (id) => ancestors(byId, id).length
    /** Sets element `d`'s place and size to rectangle `p` (world px). */
    const placeEl = (d, p) => Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` })

    // ---------- drawing ----------

    function draw() {
      world.textContent = ''
      nodeEls.clear()
      if (!L) { world.append(el('p', 'gwait', laying ? 'Laying out the map…' : '')); return }
      world.style.width = `${L.w}px`
      world.style.height = `${L.h}px`
      const steps = stepsOf(J)
      // Containers first (outer ones under inner ones), then the arrows, then the leaves and the arrow labels.
      const containers = J.nodes.filter((n) => (L.kids.get(n.id) || []).length).sort((a, b) => depth(a.id) - depth(b.id))
      for (const n of containers) {
        const p = L.abs.get(n.id)
        if (!p) continue
        const d = el('div', `gbox group ${n.kind} d${Math.min(depth(n.id), 2)}`)
        d.dataset.id = n.id
        placeEl(d, p)
        const t = titleEl(n)
        t.title = [n.label, plain(n.blurb || n.summary)].filter(Boolean).join('\n')
        d.append(t)
        d.onclick = (e) => { if (e.target.closest('.gnum')) return; e.stopPropagation(); if (!host.isTutorialUp()) fitBox(n.id) }
        world.append(d)
        nodeEls.set(n.id, d)
      }
      const svg = svgEl('svg', { class: 'gedges', width: L.w, height: L.h, viewBox: `0 0 ${L.w} ${L.h}` })
      svg.append(arrowHeads())
      for (const ed of L.edges) {
        const p = svgEl('path', {
          d: ed.bez ? curveD(ed.bez) : pathD(ed.pts),
          class: `gedge${ed.e.async ? ' async' : ''}`,
          'marker-end': 'url(#garrow)',
          'data-from': ed.e.from,
          'data-to': ed.e.to,
          'data-i': ed.i,
        })
        svg.append(p)
      }
      world.append(svg)
      for (const n of J.nodes) {
        if ((L.kids.get(n.id) || []).length) continue
        const p = L.abs.get(n.id)
        if (!p) continue
        const d = leafEl(n, steps.get(n.id) || [])
        d.dataset.id = n.id
        placeEl(d, p)
        const where = n.at ? `${n.at.file}:${n.at.start}` : n.path || ''
        d.title = [n.label, plain(n.blurb || n.summary), where].filter(Boolean).join('\n')
        const target = openTarget(n)
        if (!target) d.classList.add('inert')
        d.onclick = (e) => {
          e.stopPropagation()
          if (host.isTutorialUp()) return
          const b = e.target.closest('.gnum')
          if (b) return host.goStep(Number(b.dataset.n))
          if (target) host.open(target)
        }
        for (const b of d.querySelectorAll('.gnum')) {
          const s = J.steps[Number(b.dataset.n) - 1]
          if (s) b.title = `Step ${s.n}: ${s.title}`
        }
        world.append(d)
        nodeEls.set(n.id, d)
      }
      for (const ed of L.edges) {
        if (!ed.label || !ed.text) continue
        const t = el('div', `glabel${ed.e.async ? ' async' : ''}`, ed.text)
        t.dataset.i = ed.i
        Object.assign(t.style, { left: `${ed.label.x}px`, top: `${ed.label.y}px`, width: `${ed.label.w}px` })
        const all = [ed.e.label, ed.e.detail].filter(Boolean)
        if (all.join('') !== ed.text) t.title = all.join('\n')
        world.append(t)
      }
      // Far out, a box that holds only leaves becomes one quiet block with its name and its step numbers (no mush of
      // tiny boxes); leaves no block covers (a record in a system, a top-level box) get theirs too. Placed by farNames.
      names.textContent = ''
      farM = undefined
      const covered = new Set()
      const farName = (n, kind, nums) => {
        const t = el('div', `gname ${kind} ${n.kind}`)
        t.dataset.id = n.id
        t.append(el('span', 'gnt', n.label))
        if (nums.length) {
          const s = el('div', 'gfnums')
          for (const v of nums) {
            const b = el('button', 'gfn', String(v))
            b.dataset.n = v
            b.tabIndex = -1
            const st = J.steps[v - 1]
            if (st) b.title = `Step ${st.n}: ${st.title}`
            b.onclick = (e) => { e.stopPropagation(); if (!host.isTutorialUp()) host.goStep(v) }
            s.append(b)
          }
          t.append(s)
        }
        names.append(t)
      }
      for (const n of containers) {
        const ch = L.kids.get(n.id) || []
        const inner = ch.every((c) => !(L.kids.get(c.id) || []).length)
        if (inner) {
          covered.add(n.id)
          const c = el('div', 'gcover')
          c.dataset.id = n.id
          placeEl(c, L.abs.get(n.id))
          world.append(c)
        }
        const nums = inner ? ch.flatMap((c) => steps.get(c.id) || []).sort((a, b) => a - b) : []
        farName(n, inner ? 'inner' : 'outer', nums)
      }
      for (const n of J.nodes) {
        if ((L.kids.get(n.id) || []).length || covered.has(n.parent) || !L.abs.get(n.id)) continue
        farName(n, 'leaf', steps.get(n.id) || [])
      }
      // The current step's box, ringed in screen space (its own ring is too thin to see far out).
      ring = el('div', 'gring')
      names.append(ring)
      mark()
      host.rendered(J.nodes.length)
    }

    /** The arrows' heads: `#garrow`, and `#garrow-on` for the current step's arrows. */
    function arrowHeads() {
      const defs = svgEl('defs', {})
      for (const [id, cls] of [['garrow', 'gah'], ['garrow-on', 'gah on']]) {
        const shape = { viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }
        const m = svgEl('marker', { id, ...shape })
        m.append(svgEl('path', { class: cls, d: ARROW_HEAD }))
        defs.append(m)
      }
      return defs
    }

    /** What a leaf opens: its code (`at`), else its path, else its first step's lines. */
    function openTarget(n) {
      if (n.at) return `${n.at.file}:${n.at.start}-${n.at.end}`
      if (n.path) return n.path
      const s = J.steps.find((x) => x.node === n.id)
      return s ? `${s.file}:${s.range.start}-${s.range.end}` : ''
    }

    /** The current step: its box ringed, its number lit, its arrows drawn normally (the rest faint). */
    function mark() {
      const node = currentNode()
      for (const [id, d] of nodeEls) d.classList.toggle('current', id === node)
      const holder = node && byId.get(node)?.parent
      for (const c of world.querySelectorAll('.gcover')) c.classList.toggle('current', c.dataset.id === holder)
      for (const b of world.querySelectorAll('.gnum')) b.classList.toggle('cur', Number(b.dataset.n) === cur)
      for (const b of names.querySelectorAll('.gfn')) b.classList.toggle('cur', Number(b.dataset.n) === cur)
      if (view.classList.contains('far')) farNames()
      const on = (from, to) => !node || from === node || to === node
      for (const p of world.querySelectorAll('path.gedge')) {
        const yes = on(p.dataset.from, p.dataset.to)
        p.classList.toggle('faint', !yes)
        p.classList.toggle('on', !!node && yes)
        p.setAttribute('marker-end', `url(#garrow${node && yes ? '-on' : ''})`)
      }
      for (const t of world.querySelectorAll('.glabel')) {
        const ed = L.edges.find((x) => String(x.i) === t.dataset.i)
        t.classList.toggle('faint', !on(ed.e.from, ed.e.to))
      }
      // On top: the current box's arrows over the faint ones.
      const svg = world.querySelector('svg.gedges')
      if (svg) for (const p of [...svg.querySelectorAll('path.gedge.on')]) svg.append(p)
    }

    // ---------- the view ----------

    function apply() {
      world.style.transform = `translate(${x}px, ${y}px) scale(${k})`
      const far = k < FAR
      view.classList.toggle('far', far)
      names.hidden = !far
      if (far) farNames()
      placeLegend()
    }

    /**
     * Far names (journey-farnames.js), never over each other: the current step's ring first, then most important
     * first (its block, systems, then blocks by size, then lone boxes). Nothing goes under the legend.
     */
    function farNames() {
      if (!L || !ring) return
      if (!farM) farM = FarNames.measure(names)
      const taken = []
      if (!leg.hidden && leg.offsetParent) {
        taken.push({ x: leg.offsetLeft - 2, y: leg.offsetTop - 2, w: leg.offsetWidth + 4, h: leg.offsetHeight + 4 })
      }
      const scr = (p) => ({ x: x + p.x * k, y: y + p.y * k, w: p.w * k, h: p.h * k })
      const node = currentNode()
      const ringR = placeRing(node && L.abs.get(node), scr)
      if (ringR) taken.push(ringR)
      const holder = node && byId.get(node)?.parent
      const items = [...farM]
        .map(([t, f]) => ({ t, f, p: L.abs.get(t.dataset.id) }))
        .filter((i) => i.p)
        .map((i) => {
          const id = i.t.dataset.id
          return { ...i, B: scr(i.p), own: id === holder, rank: farRank(id, i.f.kind, node, holder) }
        })
      FarNames.place(items, taken, ringR)
    }

    /** The ring around box `p` (world px; none: hidden), on screen through `scr`; returns its rectangle. */
    function placeRing(p, scr) {
      if (!p) { ring.style.display = 'none'; return undefined }
      const r = scr(p), m = 3, w = Math.max(10, r.w + 2 * m), h = Math.max(10, r.h + 2 * m)
      const rr = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
      Object.assign(ring.style, { display: '', left: `${rr.x}px`, top: `${rr.y}px`, width: `${rr.w}px`, height: `${rr.h}px` })
      return rr
    }

    /** Which far names are placed first (lowest first). */
    function farRank(id, kind, node, holder) {
      // The current step's box and the block holding it.
      if (id === holder || id === node) return 0
      // Systems, outer ones first.
      if (kind === 'outer') return 1 + depth(id) / 100
      // Blocks of leaves.
      if (kind === 'inner') return 2
      // Lone boxes.
      return 3
    }

    const vw = () => stage.clientWidth, vh = () => stage.clientHeight
    /** The view at (nx, ny) and zoom nk, kept so no empty band shows at an edge while the map is bigger than the view
     *  (12 px of margin), and a smaller map stays inside it. */
    function clamp(nx, ny, nk) {
      if (!L) return { x: nx, y: ny }
      const m = 12
      // One axis: offset v of a map `size` long in a view `view` long.
      const one = (v, size, view) => {
        if (size + 2 * m <= view) return between(v, m, view - size - m)
        return between(v, view - size - m, m)
      }
      return { x: one(nx, L.w * nk, vw()), y: one(ny, L.h * nk, vh()) }
    }
    function set(nx, ny, nk, animate) {
      nk = Math.max(KMIN, Math.min(KMAX, nk))
      const c = clamp(nx, ny, nk)
      cancelAnimationFrame(anim)
      if (!animate || reduced() || !view.isConnected) { x = c.x; y = c.y; k = nk; apply(); return }
      const x0 = x, y0 = y, k0 = k, t0 = performance.now(), T = 320
      const ease = (t) => 1 - Math.pow(1 - t, 3)
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / T), e = ease(t)
        // Zoom interpolated in log space, so it feels even.
        k = Math.exp(Math.log(k0) + (Math.log(nk) - Math.log(k0)) * e)
        x = x0 + (c.x - x0) * e
        y = y0 + (c.y - y0) * e
        apply()
        if (t < 1) anim = requestAnimationFrame(tick)
      }
      anim = requestAnimationFrame(tick)
    }
    function zoomAt(f, sx, sy, animate) {
      const nk = Math.max(KMIN, Math.min(KMAX, k * f))
      const wx = (sx - x) / k, wy = (sy - y) / k
      set(sx - wx * nk, sy - wy * nk, nk, animate)
    }
    function zoomBy(f) { zoomAt(f, vw() / 2, vh() / 2, true) }
    /** The rectangle (world px) in view, with a margin, at most KMAX. */
    function show(r, animate, kmax = 1.4, center) {
      const pad = 16
      const nk = Math.max(KMIN, Math.min(kmax, (vw() - 2 * pad) / r.w, (vh() - 2 * pad) / r.h))
      const c = center || { x: r.x + r.w / 2, y: r.y + r.h / 2 }
      set(vw() / 2 - c.x * nk, vh() / 2 - c.y * nk, nk, animate)
    }
    function fit(animate) { if (L) show({ x: 0, y: 0, w: L.w, h: L.h }, animate, 1.2) }
    function fitBox(id) { const p = L && L.abs.get(id); if (p) show(p, true, 1.4) }

    /** The margin (px) around what follow() keeps in view. */
    const FOLLOW_PAD = 28

    /**
     * The current step's box at a readable zoom with its neighbourhood (the boxes its arrows reach) in view when that
     * fits at READ or more; centred on the neighbourhood, the box itself always fully in view.
     */
    function follow(animate) {
      if (!L || !J || host.isTutorialUp()) return
      const node = currentNode()
      followed = cur
      host.view(node && L.abs.get(node) ? node : '')
      if (!node || !L.abs.get(node)) return fit(animate)
      const p = L.abs.get(node)
      const near = [p, ...neighbours(node)]
      // Drop the farthest neighbours until the rest fit at a readable zoom.
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2
      const away = (r) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy)
      near.sort((a, b) => away(a) - away(b))
      let n = near.length
      while (n > 1 && zoomToFit(boundingBox(near.slice(0, n))) < READ) n--
      // All of them in view: as close as 1.1; else at the readable zoom, leaning toward them all (more of them shows).
      const all = n === near.length
      const r = boundingBox(near)
      const readable = Math.min(READ, zoomToFit(p))
      const nk = all ? Math.max(readable, Math.min(1.1, zoomToFit(r))) : readable
      // The neighbourhood's centre, moved toward the box as far as needed to keep the box in view.
      const slackX = Math.max(0, (vw() / 2 - FOLLOW_PAD) / nk - p.w / 2)
      const slackY = Math.max(0, (vh() / 2 - FOLLOW_PAD) / nk - p.h / 2)
      const c = {
        x: between(r.x + r.w / 2, cx - slackX, cx + slackX),
        y: between(r.y + r.h / 2, cy - slackY, cy + slackY),
      }
      set(vw() / 2 - c.x * nk, vh() / 2 - c.y * nk, nk, animate)
    }

    /** The boxes (world px) around node `id`: those its arrows reach; none: the others in its module (its context,
     *  not one box in an empty frame). */
    function neighbours(id) {
      const near = []
      for (const e of J.edges) {
        const o = otherEnd(e, id)
        if (o && L.abs.get(o)) near.push(L.abs.get(o))
      }
      if (near.length) return near
      const par = byId.get(id)?.parent
      for (const m of J.nodes) if (par && m.parent === par && m.id !== id && L.abs.get(m.id)) near.push(L.abs.get(m.id))
      return near
    }

    /** The node at edge `e`'s other end from `id` ('': `id` is at neither). */
    function otherEnd(e, id) {
      if (e.from === id) return e.to
      if (e.to === id) return e.from
      return ''
    }

    /** The smallest rectangle holding `rects` (all { x, y, w, h }). */
    function boundingBox(rects) {
      const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y))
      const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h))
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    /** The zoom at which rectangle `r` (world px) just fits the view, FOLLOW_PAD around it. */
    function zoomToFit(r) {
      return Math.min((vw() - 2 * FOLLOW_PAD) / r.w, (vh() - 2 * FOLLOW_PAD) / r.h)
    }

    function paintLegend() {
      leg.hidden = legendHidden
      q.classList.toggle('on', !legendHidden)
      q.setAttribute('aria-expanded', String(!legendHidden))
      if (legendHidden) return
      leg.textContent = ''
      // One row each: a sample, what it means.
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
      placeLegend()
    }
    /** Above the controls, at their corner; another corner when it would cover the current step's box. */
    function placeLegend() {
      if (legendHidden || !view.isConnected) return
      const node = currentNode()
      const box = node && (view.classList.contains('far') && ring?.style.display !== 'none' ? ring : nodeEls.get(node))
      const b = box && box.getBoundingClientRect()
      const below = view.clientHeight - stage.offsetTop - stage.offsetHeight + 4
      const spots = [{ right: 6, bottom: below }, { left: 6, bottom: below }, { right: 6, top: 6 }, { left: 6, top: 6 }]
      for (const sp of spots) {
        Object.assign(leg.style, { left: '', right: '', top: '', bottom: '' }, Object.fromEntries(Object.entries(sp).map(([k2, v]) => [k2, `${v}px`])))
        if (!b) return
        const r = leg.getBoundingClientRect()
        if (!(r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom)) return
      }
      Object.assign(leg.style, { left: '', right: '6px', top: '', bottom: `${below}px` })
    }

    // ---------- input: drag, wheel, keys ----------

    let drag = null, dragged = false
    view.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.gctl, .glegend')) return
      drag = { sx: e.clientX, sy: e.clientY, x, y, id: e.pointerId, on: false }
      dragged = false
    })
    view.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
      if (!drag.on && Math.hypot(dx, dy) < 4) return
      if (!drag.on) { drag.on = true; dragged = true; cancelAnimationFrame(anim); view.setPointerCapture(e.pointerId); view.classList.add('dragging') }
      const c = clamp(drag.x + dx, drag.y + dy, k)
      x = c.x; y = c.y
      apply()
    })
    const end = () => { if (drag?.on) view.classList.remove('dragging'); drag = null }
    view.addEventListener('pointerup', end)
    view.addEventListener('pointercancel', end)
    // A drag is not a click on what it started on.
    view.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false } }, true)
    view.addEventListener('wheel', (e) => {
      if (!L) return
      const r = view.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // A mouse wheel notch is ~100; a pinch sends small steps.
        zoomAt(Math.exp(-e.deltaY * (Math.abs(e.deltaY) >= 50 ? 0.0015 : 0.01)), e.clientX - r.left, e.clientY - r.top, false)
        return
      }
      const f = e.deltaMode === 1 ? 16 : 1
      const c = clamp(x - e.deltaX * f, y - e.deltaY * f, k)
      // At the map's edge the page scrolls on (the map never traps the wheel).
      if (Math.abs(c.x - x) < 0.5 && Math.abs(c.y - y) < 0.5) return
      e.preventDefault()
      cancelAnimationFrame(anim)
      x = c.x; y = c.y
      apply()
    }, { passive: false })
    /** How far an arrow key pans (px). */
    const PAN_STEP = 60
    view.addEventListener('keydown', (e) => {
      if (host.isTutorialUp() || e.ctrlKey || e.altKey || e.metaKey) return
      runKey(e, {
        '+': () => zoomBy(ZOOM_STEP),
        '=': () => zoomBy(ZOOM_STEP),
        '-': () => zoomBy(1 / ZOOM_STEP),
        '_': () => zoomBy(1 / ZOOM_STEP),
        '0': () => fit(true),
        ArrowLeft: () => set(x + PAN_STEP, y, k, true),
        ArrowRight: () => set(x - PAN_STEP, y, k, true),
        ArrowUp: () => set(x, y + PAN_STEP, k, true),
        ArrowDown: () => set(x, y - PAN_STEP, k, true),
      }, true)
    })

    /** The view's size when the map last followed or was resized ({ w, h }; undefined: not yet). */
    let lastSize
    const viewSize = () => ({ w: vw(), h: vh() })
    return {
      el: view,
      /** A journey (or the same one again) and where the walk is. */
      set(j, current, legHidden) {
        legendHidden = legHidden
        paintLegend()
        const s = signature(j)
        const same = s === sig
        J = j
        byId = new Map(J.nodes.map((n) => [n.id, n]))
        cur = current
        if (same) { if (L) { mark(); host.rendered(J.nodes.length) } return }
        sig = s
        const hit = cache.get(s)
        if (hit) { L = hit; laying = false; draw(); followed = -1; return }
        L = undefined
        laying = true
        draw()
        layout(j).then((r) => {
          cache.set(s, r)
          if (sig !== s) return
          L = r
          laying = false
          draw()
          followed = -1
          if (view.isConnected) { lastSize = viewSize(); follow(false) }
        }).catch((e) => {
          laying = false
          const why = e && e.message || e
          world.textContent = ''
          world.append(el('p', 'gwait', `The map could not be laid out: ${why}`))
          host.error(String(why))
        })
      },
      /** After the view is in the page: follow a new step (animated), or keep the view (a size change re-centres). */
      placed() {
        if (!L) return
        const size = viewSize()
        const resized = !lastSize || size.w !== lastSize.w || size.h !== lastSize.h
        if (followed !== cur) { const smooth = followed !== -1 && !!lastSize; lastSize = size; follow(smooth) }
        else if (resized) { lastSize = size; follow(false) }
        else apply()
      },
      /**
       * The view changed width under the reader's hand (the splitter): what is on screen stays where it is (the map's
       * right edge is fixed); only if the current step's box would leave the view is it brought back.
       */
      resized() {
        if (!L || !lastSize) return
        const dw = vw() - lastSize.w
        lastSize = viewSize()
        const c = clamp(x + dw, y, k)
        x = c.x; y = c.y
        apply()
        const node = currentNode()
        const p = node && L.abs.get(node)
        if (p) {
          const l = x + p.x * k, r = x + (p.x + p.w) * k
          if (l < 0 || r > vw()) follow(false)
        }
      },
      fit: () => fit(false),
      state: () => ({ x, y, k }),
      layout: () => L,
    }
  }
})()
