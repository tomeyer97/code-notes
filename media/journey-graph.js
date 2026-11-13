// The journey's whole map at once (0.21): systems contain their modules, modules their functions; every
// edge between its real ends, with its label. Laid out by ELK (layered, hierarchical: out/vendor/elk.bundled.js, loaded
// before this file as window.ELK), cached per journey. Pan (drag, wheel), zoom (Ctrl+wheel, + − Fit, keys), and it
// follows the step: the current step's box centred at a readable zoom, ringed. Function boxes carry their step numbers.
// Needs journeyModel.js (`exports`) for isGeneric.
// API: const g = JourneyGraph({ goStep(n), open(path), quiet (true: the tutorial is up, nothing moves), legend(hidden), rendered(boxes), view(node), error(message) })
//      g.el (the viewport, re-appended on every render)  g.set(J, cur, legendHidden)  g.follow(animate)  g.resized
;(function () {
  const M = window.exports
  const SVG = 'http://www.w3.org/2000/svg'
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const svgEl = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }
  const plain = (s) => (s || '').replace(/`|\*\*/g, '')
  /** An arrow label as a plain verb phrase: the first clause, without timings ("polls every 3 s, max 10 min" → "polls"). */
  const UNIT = '(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)'
  const verb = (l) => l.split(/[;,(]/)[0]
    .replace(new RegExp(`\\s+(?:every|each|after|within|in|for|up to|for up to|max\\.?|at most)\\s+(?:up to\\s+)?[\\d.]+\\s*${UNIT}\\b.*$`, 'i'), '')
    .replace(new RegExp(`\\s+[\\d.]+\\s*${UNIT}\\b`, 'gi'), '').trim()
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /** Zoom bounds; below FAR the leaves' text and the arrow labels are hidden (too small to read), titles stay. */
  const KMIN = 0.12, KMAX = 2.5, FAR = 0.55, READ = 0.8
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
    const btn = (cls, text, title, fn) => { const b = el('button', `gbtn ${cls}`, text); b.title = title; b.setAttribute('aria-label', title); b.onclick = (e) => { e.stopPropagation(); fn() }; ctl.append(b); return b }
    btn('gin', '+', 'Zoom in (+)', () => zoomBy(1.25))
    btn('gout', '−', 'Zoom out (−)', () => zoomBy(0.8))
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
    /** Far out: each name's measured variants (farMeasure), and the current step's ring. */
    let farM, ring
    /** The view: screen = world * k + (x, y). */
    let x = 0, y = 0, k = 1
    let anim = 0
    /** The step the map last followed: a new one moves it (also back from wherever it was dragged). */
    let followed = -1
    const nodeEls = new Map()

    // ---------- layout (ELK), cached ----------

    function signature(j) {
      return JSON.stringify([j.nodes.map((n) => [n.id, n.kind, n.label, n.parent || '']), j.edges.map((e) => [e.from, e.to, e.label, !!e.async]), j.steps.map((s) => s.node)])
    }
    /** The size a box's text needs, measured with the real styles. */
    function measurer() {
      const box = el('div', 'gmeasure')
      document.body.append(box)
      const size = (e) => { box.append(e); const r = { w: Math.ceil(e.offsetWidth) + 1, h: Math.ceil(e.offsetHeight) }; e.remove(); return r }
      return { size, done: () => box.remove() }
    }
    function stepsOf(j) {
      const m = new Map()
      for (const s of j.steps) { if (!m.has(s.node)) m.set(s.node, []); m.get(s.node).push(s.n) }
      return m
    }

    async function layout(j) {
      const byId = new Map(j.nodes.map((n) => [n.id, n]))
      const kids = new Map()
      for (const n of j.nodes) { const p = n.parent && byId.has(n.parent) ? n.parent : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n) }
      const steps = stepsOf(j)
      // Children in the order the path first reaches them (unvisited last): ELK keeps the model order where it can.
      const firstMemo = new Map()
      const first = (id) => {
        if (firstMemo.has(id)) return firstMemo.get(id)
        const v = Math.min(steps.get(id)?.[0] ?? Infinity, ...(kids.get(id) || []).map((c) => first(c.id)))
        firstMemo.set(id, v)
        return v
      }
      for (const list of kids.values()) list.sort((a, b) => first(a.id) - first(b.id))
      const pathOf = (id) => { const o = []; for (let n = byId.get(id); n && o.length <= j.nodes.length; n = byId.get(n.parent)) o.unshift(n.id); return o }
      const ms = measurer()
      const titleH = {}
      const mk = (n, parentTitle) => {
        const ch = kids.get(n.id) || []
        if (ch.length) {
          const t = ms.size(titleEl(n))
          titleH[n.id] = t.h
          return { id: n.id, layoutOptions: { 'elk.padding': `[top=${t.h + 10},left=12,bottom=12,right=12]` }, children: ch.map((c) => mk(c, ch.length === 1 ? t.w : 0)), edges: [] }
        }
        const s = ms.size(leafEl(n, steps.get(n.id) || []))
        // The only box in a module: at least as wide as the module's title (ELK can't be told a compound's minimum here).
        return { id: n.id, width: Math.max(s.w, parentTitle - 4), height: s.h }
      }
      const root = {
        id: '#root',
        layoutOptions: {
          'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
          'elk.spacing.nodeNode': '22', 'elk.layered.spacing.nodeNodeBetweenLayers': '26', 'elk.spacing.edgeNode': '14', 'elk.spacing.edgeEdge': '10',
          'elk.layered.spacing.edgeNodeBetweenLayers': '14', 'elk.layered.spacing.edgeEdgeBetweenLayers': '8', 'elk.spacing.edgeLabel': '3',
          'elk.edgeLabels.placement': 'CENTER', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.padding': '[top=8,left=8,bottom=8,right=8]',
        },
        children: (kids.get('') || []).map((n) => mk(n, 0)), edges: [],
      }
      const elkById = new Map()
      const walk = (g) => { elkById.set(g.id, g); for (const c of g.children || []) walk(c) }
      walk(root)
      // Each edge in the innermost box holding both ends (its coordinates come back relative to that box).
      const edges = []
      j.edges.forEach((e, i) => {
        const pa = pathOf(e.from), pb = pathOf(e.to)
        let c = 0
        while (c < pa.length && c < pb.length && pa[c] === pb[c]) c++
        let common = pa.slice(0, c)
        while (common.length && (common[common.length - 1] === e.from || common[common.length - 1] === e.to)) common.pop()
        const container = common[common.length - 1] || '#root'
        const text = M.isGeneric(e.label) ? '' : verb(e.label)
        const lab = text ? ms.size(el('div', 'glabel', text)) : undefined
        const ee = { id: `e${i}`, sources: [e.from], targets: [e.to], ...(lab ? { labels: [{ id: `e${i}l`, text, width: lab.w, height: lab.h }] } : {}) }
        elkById.get(container).edges.push(ee)
        edges.push({ i, e, text, container, ee })
      })
      ms.done()
      const out = await new window.ELK().layout(root)
      // Absolute positions.
      const abs = new Map()
      const place = (g, ox, oy) => { const ax = ox + (g.x || 0), ay = oy + (g.y || 0); abs.set(g.id, { x: ax, y: ay, w: g.width, h: g.height }); for (const c of g.children || []) place(c, ax, ay) }
      place(out, 0, 0)
      const outById = new Map()
      const walk2 = (g) => { outById.set(g.id, g); for (const e of g.edges || []) outById.set(e.id, e); for (const c of g.children || []) walk2(c) }
      walk2(out)
      const edgesOut = edges.map(({ i, e, text, container, ee }) => {
        const o = outById.get(`e${i}`)
        const base = abs.get(container) || { x: 0, y: 0 }
        const pts = (o.sections || []).flatMap((s) => [s.startPoint, ...(s.bendPoints || []), s.endPoint]).map((p) => ({ x: p.x + base.x, y: p.y + base.y }))
        const lab = ee.labels?.[0]
        return { i, e, text, pts, cross: (byId.get(e.from)?.parent || '') !== (byId.get(e.to)?.parent || ''), ...(lab ? { lw: lab.width, lh: lab.height } : {}) }
      })
      curves(edgesOut, abs, kids)
      placeLabels(edgesOut, abs, kids, titleH)
      return { w: out.width, h: out.height, abs, titleH, kids, edges: edgesOut }
    }

    /**
     * Arrows between boxes in different modules: one simple curve from end to end (ELK routes them around whole
     * modules, in long detours that read like empty boxes). Ends spread along the side they leave/enter, in the order
     * of the far end, so curves from one box don't cross each other.
     */
    function curves(edges, abs, kidsOf) {
      const ends = new Map() // `${id}|${side}` -> [{ ed, which, key }]
      for (const ed of edges) {
        if (!ed.cross) continue
        const s = abs.get(ed.e.from), t = abs.get(ed.e.to)
        if (!s || !t) continue
        let ss, ts
        if (t.y >= s.y + s.h + 6) { ss = 'b'; ts = 't' }
        else if (t.y + t.h + 6 <= s.y) { ss = 't'; ts = 'b' }
        else if (t.x >= s.x + s.w / 2) { ss = 'r'; ts = 'l' } else { ss = 'l'; ts = 'r' }
        ed.sides = [ss, ts]
        const add = (id, side, which, other) => { const k = `${id}|${side}`; if (!ends.has(k)) ends.set(k, []); ends.get(k).push({ ed, which, key: side === 'b' || side === 't' ? other.x + other.w / 2 : other.y + other.h / 2 }) }
        add(ed.e.from, ss, 0, t)
        add(ed.e.to, ts, 1, s)
      }
      for (const [k, list] of ends) {
        const [id, side] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)]
        const r = abs.get(id)
        list.sort((a, b) => a.key - b.key)
        list.forEach((x, i) => {
          const f = (i + 1) / (list.length + 1)
          const p = side === 'b' ? { x: r.x + r.w * f, y: r.y + r.h } : side === 't' ? { x: r.x + r.w * f, y: r.y } : side === 'l' ? { x: r.x, y: r.y + r.h * f } : { x: r.x + r.w, y: r.y + r.h * f }
          ;(x.ed.anchor || (x.ed.anchor = []))[x.which] = { ...p, side }
        })
      }
      for (const ed of edges) {
        if (!ed.anchor || !ed.anchor[0] || !ed.anchor[1]) continue
        const [a, b] = ed.anchor
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        const out = (p, m) => (p.side === 'b' ? { x: p.x, y: p.y + m } : p.side === 't' ? { x: p.x, y: p.y - m } : p.side === 'l' ? { x: p.x - m, y: p.y } : { x: p.x + m, y: p.y })
        const m = Math.max(20, Math.min(90, d / 2.5))
        // Only a curve that crosses no other box (a line under a box reads as an arrow into it): bent sideways as far as
        // needed; when none is clear, ELK's route.
        const vert = a.side === 'b' || a.side === 't'
        const leaves = [...abs].filter(([id]) => id !== ed.e.from && id !== ed.e.to && id !== '#root' && !(kidsOf.get(id) || []).length).map(([, r]) => r)
        const clear = (bz) => { const pts = samples({ bez: bz }); return !leaves.some((r) => pts.some((q) => q.x > r.x - 6 && q.x < r.x + r.w + 6 && q.y > r.y - 6 && q.y < r.y + r.h + 6)) }
        let bez
        for (const off of [0, -50, 50, -100, 100, -160, 160, -240, 240]) {
          const sh = (p) => (vert ? { x: p.x + off, y: p.y } : { x: p.x, y: p.y + off })
          const bz = [a, sh(out(a, m)), sh(out(b, m)), b]
          if (clear(bz)) { bez = bz; break }
        }
        if (!bez) continue
        ed.bez = bez
        delete ed.pts
      }
    }

    /** Points along an arrow, every ~4 px (for placing its label on it). */
    function samples(ed) {
      const out = []
      if (ed.bez) {
        const [p0, p1, p2, p3] = ed.bez
        for (let i = 0; i <= 60; i++) { const t = i / 60, u = 1 - t; out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y }) }
        return out
      }
      const P = ed.pts
      for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4)); for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }) }
      return out
    }

    /** Each label centred on its own line, where it covers no box, title or other label (else where it covers least). */
    function placeLabels(edges, abs, kids, titleH) {
      const obstacles = []
      for (const [id, r] of abs) {
        if (id === '#root') continue
        if ((kids.get(id) || []).length) obstacles.push({ x: r.x, y: r.y, w: Math.min(r.w, 260), h: (titleH[id] || 18) + 6 })
        else obstacles.push({ ...r })
      }
      const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
      // Shorter arrows first: they have the fewest places to go.
      const order = edges.filter((ed) => ed.text && ed.lw).map((ed) => ({ ed, pts: samples(ed) })).sort((a, b) => a.pts.length - b.pts.length)
      for (const { ed, pts } of order) {
        let best, bestCost = Infinity
        for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
          const p = pts[Math.round((pts.length - 1) * f)]
          const r = { x: p.x - ed.lw / 2, y: p.y - ed.lh / 2, w: ed.lw, h: ed.lh }
          const cost = obstacles.reduce((c, o) => c + area(r, o), 0) + Math.abs(f - 0.5) * 20
          if (cost < bestCost) { bestCost = cost; best = r }
          if (cost <= Math.abs(f - 0.5) * 20) break
        }
        ed.label = best
        obstacles.push(best)
      }
    }

    // ---------- drawing ----------

    function titleEl(n) { const t = el('div', `gtitle ${n.kind}`, n.label); return t }
    function leafEl(n, nums) {
      const d = el('div', `gbox leaf ${n.kind}`)
      d.append(el('span', 'glbl', n.label))
      if (nums.length) {
        const s = el('span', 'gnums')
        for (const v of nums) { const b = el('button', 'gnum', String(v)); b.dataset.n = v; s.append(b) }
        d.append(s)
      }
      return d
    }
    /** A rounded orthogonal polyline. */
    function pathD(pts) {
      if (pts.length < 2) return ''
      let d = `M${pts[0].x},${pts[0].y}`
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1]
        const r = Math.min(6, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
        const u = (p, q) => { const l = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: (q.x - p.x) / l, y: (q.y - p.y) / l } }
        const ua = u(b, a), uc = u(b, c)
        d += ` L${b.x + ua.x * r},${b.y + ua.y * r} Q${b.x},${b.y} ${b.x + uc.x * r},${b.y + uc.y * r}`
      }
      const z = pts[pts.length - 1]
      return `${d} L${z.x},${z.y}`
    }

    function draw() {
      world.textContent = ''
      nodeEls.clear()
      if (!L) { world.append(el('p', 'gwait', laying ? 'Laying out the map…' : '')); return }
      world.style.width = `${L.w}px`
      world.style.height = `${L.h}px`
      const steps = stepsOf(J)
      const byId = new Map(J.nodes.map((n) => [n.id, n]))
      // Containers first (outer ones under inner ones), then the arrows, then the leaves and the arrow labels.
      const depth = (id) => { let d = 0; for (let n = byId.get(id); n && n.parent; n = byId.get(n.parent)) d++; return d }
      const containers = J.nodes.filter((n) => (L.kids.get(n.id) || []).length).sort((a, b) => depth(a.id) - depth(b.id))
      for (const n of containers) {
        const p = L.abs.get(n.id)
        if (!p) continue
        const d = el('div', `gbox group ${n.kind} d${Math.min(depth(n.id), 2)}`)
        d.dataset.id = n.id
        Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` })
        const t = titleEl(n)
        t.title = [n.label, plain(n.blurb || n.summary)].filter(Boolean).join('\n')
        d.append(t)
        d.onclick = (e) => { if (e.target.closest('.gnum')) return; e.stopPropagation(); if (!host.quiet()) fitBox(n.id) }
        world.append(d)
        nodeEls.set(n.id, d)
      }
      const svg = svgEl('svg', { class: 'gedges', width: L.w, height: L.h, viewBox: `0 0 ${L.w} ${L.h}` })
      svg.innerHTML = '<defs><marker id="garrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="gah" d="M0,0 L8,4 L0,8 z"/></marker>' +
        '<marker id="garrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="gah on" d="M0,0 L8,4 L0,8 z"/></marker></defs>'
      for (const ed of L.edges) {
        const p = svgEl('path', { d: ed.bez ? `M${ed.bez[0].x},${ed.bez[0].y} C${ed.bez[1].x},${ed.bez[1].y} ${ed.bez[2].x},${ed.bez[2].y} ${ed.bez[3].x},${ed.bez[3].y}` : pathD(ed.pts), class: `gedge${ed.e.async ? ' async' : ''}`, 'marker-end': 'url(#garrow)', 'data-from': ed.e.from, 'data-to': ed.e.to, 'data-i': ed.i })
        svg.append(p)
      }
      world.append(svg)
      for (const n of J.nodes) {
        if ((L.kids.get(n.id) || []).length) continue
        const p = L.abs.get(n.id)
        if (!p) continue
        const d = leafEl(n, steps.get(n.id) || [])
        d.dataset.id = n.id
        Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` })
        d.title = [n.label, plain(n.blurb || n.summary), n.at ? `${n.at.file}:${n.at.start}` : n.path || ''].filter(Boolean).join('\n')
        const target = openTarget(n)
        if (!target) d.classList.add('inert')
        d.onclick = (e) => {
          e.stopPropagation()
          if (host.quiet()) return
          const b = e.target.closest('.gnum')
          if (b) return host.goStep(Number(b.dataset.n))
          if (target) host.open(target)
        }
        for (const b of d.querySelectorAll('.gnum')) { const s = J.steps[Number(b.dataset.n) - 1]; if (s) b.title = `Step ${s.n}: ${s.title}` }
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
            b.onclick = (e) => { e.stopPropagation(); if (!host.quiet()) host.goStep(v) }
            s.append(b)
          }
          t.append(s)
        }
        names.append(t)
      }
      for (const n of containers) {
        const ch = L.kids.get(n.id) || []
        const inner = ch.every((c) => !(L.kids.get(c.id) || []).length)
        if (inner) { covered.add(n.id); const p = L.abs.get(n.id); const c = el('div', 'gcover'); c.dataset.id = n.id; Object.assign(c.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` }); world.append(c) }
        farName(n, inner ? 'inner' : 'outer', inner ? ch.flatMap((c) => steps.get(c.id) || []).sort((a, b) => a - b) : [])
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

    /** What a leaf opens: its code (`at`), else its path, else its first step's lines. */
    function openTarget(n) {
      if (n.at) return `${n.at.file}:${n.at.start}-${n.at.end}`
      if (n.path) return n.path
      const s = J.steps.find((x) => x.node === n.id)
      return s ? `${s.file}:${s.range.start}-${s.range.end}` : ''
    }

    /** The current step: its box ringed, its number lit, its arrows drawn normally (the rest faint). */
    function mark() {
      const node = cur ? J.steps[cur - 1]?.node : undefined
      for (const [id, d] of nodeEls) d.classList.toggle('current', id === node)
      const holder = node && J.nodes.find((m) => m.id === node)?.parent
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
      for (const t of world.querySelectorAll('.glabel')) { const ed = L.edges.find((x) => String(x.i) === t.dataset.i); t.classList.toggle('faint', !on(ed.e.from, ed.e.to)) }
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
     * Each far name's variants, measured once (canvas text metrics: no reflow while panning): the whole name on one
     * line, on two lines (every split), and cut after a word with "…"; plus its numbers row.
     */
    function farMeasure() {
      const cv = document.createElement('canvas').getContext('2d')
      const out = new Map()
      for (const t of names.querySelectorAll('.gname')) {
        const sp = t.querySelector('.gnt'), cs = getComputedStyle(sp)
        cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        const fs = parseFloat(cs.fontSize) || 12
        const tw = (s) => Math.ceil(cv.measureText(s).width) + 2
        const label = sp.dataset.full || sp.textContent
        sp.dataset.full = label
        const words = label.split(/\s+/).filter(Boolean)
        const lineH = Math.ceil(fs * 1.2)
        const pad = 8 // the chip's padding, both sides
        const nums = [...t.querySelectorAll('.gfn')]
        let nw = 0, nh = 0
        if (nums.length) {
          const cn = getComputedStyle(nums[0])
          cv.font = `${cn.fontWeight} ${cn.fontSize} ${cn.fontFamily}`
          nw = nums.reduce((a, b) => a + Math.max(16, Math.ceil(cv.measureText(b.textContent).width) + 10) + 3, -3)
          nh = 18
          cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        }
        const v = (text, lines, w) => ({ text, w: Math.max(w, nw) + pad, h: lines * lineH + nh + 2 })
        const whole = v(label, 1, tw(label))
        const two = []
        for (let i = 1; i < words.length; i++) { const a = words.slice(0, i).join(' '), b = words.slice(i).join(' '); two.push({ ...v(`${a}\n${b}`, 2, Math.max(tw(a), tw(b))), line: Math.max(tw(a), tw(b)) }) }
        const cut = []
        // Never just "The…": at least 6 letters kept.
        for (let i = words.length - 1; i >= 1; i--) { const a = `${words.slice(0, i).join(' ')}…`; if (a.length > 6) cut.push(v(a, 1, tw(a))) }
        // The name alone (its numbers left out) when the block is too small for both.
        const bare = (vv) => (nh ? { text: vv.text, bare: true, w: tw(vv.text.split('\n')[0]) + pad, h: lineH + 2 } : undefined)
        // The name and its numbers on one line (a flat block).
        const row = nh ? { text: label, row: true, w: tw(label) + 4 + nw + pad, h: Math.max(lineH, 16) + 2 } : undefined
        out.set(t, { whole, two, cut, row, bare: bare(whole), bareCut: cut.map(bare).filter(Boolean), kind: t.classList.contains('outer') ? 'outer' : t.classList.contains('leaf') ? 'leaf' : 'inner' })
      }
      return out
    }

    /**
     * Far names, never over each other: most important first (the current step's ring, its block, systems,
     * then blocks by size, then lone boxes); each takes the first place where it overlaps nothing placed: whole inside
     * its block, on two lines, whole past the block's edges, cut after a word with "…"; centred, at the top or at the
     * bottom of its block. A name with no free place is left out. Nothing goes under the map's buttons.
     */
    function farNames() {
      if (!L || !ring) return
      if (!farM) farM = farMeasure()
      const taken = []
      const free = (r) => !taken.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)
      if (!leg.hidden && leg.offsetParent) taken.push({ x: leg.offsetLeft - 2, y: leg.offsetTop - 2, w: leg.offsetWidth + 4, h: leg.offsetHeight + 4 })
      const scr = (p) => ({ x: x + p.x * k, y: y + p.y * k, w: p.w * k, h: p.h * k })
      // The ring.
      const node = cur ? J.steps[cur - 1]?.node : undefined
      const np = node && L.abs.get(node)
      let ringR
      if (np) {
        const r = scr(np), m = 3, w = Math.max(10, r.w + 2 * m), h = Math.max(10, r.h + 2 * m)
        const rr = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
        Object.assign(ring.style, { display: '', left: `${rr.x}px`, top: `${rr.y}px`, width: `${rr.w}px`, height: `${rr.h}px` })
        taken.push(rr)
        ringR = rr
      } else ring.style.display = 'none'
      const holder = node && J.nodes.find((n) => n.id === node)?.parent
      const depth = (id) => { let d = 0; for (let n = J.nodes.find((m) => m.id === id); n && n.parent; n = J.nodes.find((m) => m.id === n.parent)) d++; return d }
      const rank = (t, f) => (t.dataset.id === holder || t.dataset.id === node ? 0 : f.kind === 'outer' ? 1 + depth(t.dataset.id) / 100 : f.kind === 'inner' ? 2 : 3)
      const items = [...farM].map(([t, f]) => ({ t, f, p: L.abs.get(t.dataset.id) })).filter((i) => i.p)
      items.sort((a, b) => rank(a.t, a.f) - rank(b.t, b.f) || b.p.w * b.p.h - a.p.w * a.p.h)
      for (const { t, f, p } of items) {
        const B = scr(p)
        const inside = B.w - 4
        // The variants in order, each with where it may go.
        const tries = []
        if (f.kind === 'inner') {
          // The current step's block may also name itself just under or over its block (the ring is inside it).
          const ys = (h) => [B.y + B.h / 2 - h / 2, B.y + 2, B.y + B.h - h - 2, ...(t.dataset.id === holder ? [B.y + B.h + 3, B.y - h - 3] : [])]
          const at = (vv, wide) => { for (const yy of ys(vv.h)) tries.push({ vv, wide, x: B.x + B.w / 2 - vv.w / 2, y: yy }) }
          if (f.whole.w <= inside) at(f.whole, false)
          for (const vv of [...f.two].sort((a, b) => a.line - b.line)) if (vv.w <= inside && vv.h <= B.h - 2) { at(vv, false); break }
          if (f.whole.w > inside) at(f.whole, true)
          if (f.row) at(f.row, f.row.w > inside)
          if (f.bare) at(f.bare, f.bare.w > inside)
          for (const vv of f.cut) if (vv.w <= inside) { at(vv, false); break }
          for (const vv of f.bareCut) if (vv.w <= inside) { at(vv, false); break }
          // Last: just under (or over) its block, so it still has a name.
          for (const vv of [f.whole, f.bare].filter(Boolean)) for (const yy of [B.y + B.h + 3, B.y - vv.h - 3]) tries.push({ vv, wide: true, x: B.x + B.w / 2 - vv.w / 2, y: yy })
        } else {
          // A system's name at its top left; a lone box's name on it, else just under it.
          const spots = f.kind === 'outer' ? [[B.x + 1, B.y + 1]] : [[B.x + 1, B.y + 1], [B.x + 1, B.y + B.h + 5], [B.x + 1, B.y - f.whole.h - 5]]
          const room = f.kind === 'outer' ? B.w - 2 : Infinity
          for (const [sx, sy] of spots) {
            // A system's name may read past its box's right edge (on its chip) when nothing is there.
            tries.push({ vv: f.whole, wide: f.kind === 'leaf', x: sx, y: sy })
            for (const vv of f.cut) if (vv.w <= room) { tries.push({ vv, wide: f.kind === 'leaf', x: sx, y: sy }); break }
          }
        }
        let pick = tries.find((o) => free({ x: o.x, y: o.y, w: o.vv.w, h: o.vv.h }))
        // Its step numbers matter most: rather over the ring than not at all.
        if (!pick && rank(t, f) === 0 && ringR) { const i = taken.indexOf(ringR); taken.splice(i, 1); pick = tries.find((o) => free({ x: o.x, y: o.y, w: o.vv.w, h: o.vv.h })); taken.splice(i, 0, ringR) }
        if (!pick) { t.style.display = 'none'; continue }
        t.style.display = ''
        const sp = t.firstChild
        if (sp.textContent !== pick.vv.text) sp.textContent = pick.vv.text
        t.classList.toggle('wide', pick.wide)
        const nums = t.querySelector('.gfnums')
        if (nums) nums.style.display = pick.vv.bare ? 'none' : ''
        t.classList.toggle('row', !!pick.vv.row)
        Object.assign(t.style, { left: `${pick.x}px`, top: `${pick.y}px` })
        taken.push({ x: pick.x, y: pick.y, w: pick.vv.w, h: pick.vv.h })
      }
    }
    const vw = () => stage.clientWidth, vh = () => stage.clientHeight
    /** Keep some of the map in view whatever the pan. */
    /** No empty band at an edge while the map is bigger than the view; a smaller map stays inside it. */
    function clamp(nx, ny, nk) {
      if (!L) return { x: nx, y: ny }
      const m = 12
      const one = (v, size, view) => (size + 2 * m <= view ? Math.min(view - size - m, Math.max(m, v)) : Math.min(m, Math.max(view - size - m, v)))
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

    /**
     * The current step's box at a readable zoom with its neighbourhood (the boxes its arrows reach) in view when that
     * fits at READ or more; centred on the neighbourhood, the box itself always fully in view.
     */
    function follow(animate) {
      if (!L || !J || host.quiet()) return
      const node = cur ? J.steps[cur - 1]?.node : undefined
      followed = cur
      host.view(node && L.abs.get(node) ? node : '')
      if (!node || !L.abs.get(node)) return fit(animate)
      const p = L.abs.get(node)
      const near = [p]
      for (const e of J.edges) { const o = e.from === node ? e.to : e.to === node ? e.from : ''; if (o && L.abs.get(o)) near.push(L.abs.get(o)) }
      // No arrows: the boxes beside it in its module are its context (not one box in an empty frame:).
      if (near.length === 1) { const par = J.nodes.find((m) => m.id === node)?.parent; for (const m of J.nodes) if (par && m.parent === par && m.id !== node && L.abs.get(m.id)) near.push(L.abs.get(m.id)) }
      const pad = 28
      const box = (rs) => { const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y)); return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 } }
      // Drop the farthest neighbours until the rest fit at a readable zoom.
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2
      near.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))
      const kOf = (r) => Math.min((vw() - 2 * pad) / r.w, (vh() - 2 * pad) / r.h)
      let n = near.length
      while (n > 1 && kOf(box(near.slice(0, n))) < READ) n--
      // All of them in view: as close as 1.1; else at the readable zoom, leaning toward them all (more of them shows).
      const all = n === near.length
      const r = box(near)
      const nk = all ? Math.max(Math.min(READ, kOf(p)), Math.min(1.1, kOf(r))) : Math.min(READ, kOf(p))
      // The neighbourhood's centre, moved toward the box as far as needed to keep the box in view.
      let c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
      const hx = (vw() / 2 - pad) / nk - p.w / 2, hy = (vh() / 2 - pad) / nk - p.h / 2
      c = { x: Math.min(cx + Math.max(0, hx), Math.max(cx - Math.max(0, hx), c.x)), y: Math.min(cy + Math.max(0, hy), Math.max(cy - Math.max(0, hy), c.y)) }
      set(vw() / 2 - c.x * nk, vh() / 2 - c.y * nk, nk, animate)
    }

    function paintLegend() {
      leg.hidden = legendHidden
      q.classList.toggle('on', !legendHidden)
      q.setAttribute('aria-expanded', String(!legendHidden))
      if (legendHidden) return
      leg.textContent = ''
      const line = (cls, text) => { const r = el('div', 'gkey'); const s = svgEl('svg', { width: 26, height: 8, 'aria-hidden': 'true' }); s.append(svgEl('path', { d: 'M1,4 H25', class: `gedge ${cls}` })); r.append(s, document.createTextNode(text)); leg.append(r) }
      line('', 'call')
      line('async', 'later (poll, watch)')
      const r = el('div', 'gkey'); r.append(el('span', 'gsample store'), document.createTextNode('the app\'s own record')); leg.append(r)
      const r2 = el('div', 'gkey'); r2.append(el('span', 'gnum', '4'), document.createTextNode('step (click to go)')); leg.append(r2)
      const r3 = el('div', 'gkey'); r3.append(el('span', 'gsample cur'), document.createTextNode('this step · drag to move, Ctrl+wheel to zoom')); leg.append(r3)
      placeLegend()
    }
    /** Above the controls, at their corner; another corner when it would cover the current step's box. */
    function placeLegend() {
      if (legendHidden || !view.isConnected) return
      const node = cur ? J?.steps[cur - 1]?.node : undefined
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
    view.addEventListener('keydown', (e) => {
      if (host.quiet() || e.ctrlKey || e.altKey || e.metaKey) return
      const P = 60
      const keys = { '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), '_': () => zoomBy(0.8), '0': () => fit(true),
        ArrowLeft: () => set(x + P, y, k, true), ArrowRight: () => set(x - P, y, k, true), ArrowUp: () => set(x, y + P, k, true), ArrowDown: () => set(x, y - P, k, true) }
      const f = keys[e.key]
      if (!f) return
      e.preventDefault()
      e.stopPropagation()
      f()
    })

    let lastSize = ''
    return {
      el: view,
      /** A journey (or the same one again) and where the walk is. */
      set(j, current, legHidden) {
        legendHidden = legHidden
        paintLegend()
        const s = signature(j)
        const same = s === sig
        J = j
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
          if (view.isConnected) { lastSize = `${vw()}x${vh()}`; follow(false) }
        }).catch((e) => { laying = false; world.textContent = ''; world.append(el('p', 'gwait', `The map could not be laid out: ${e && e.message || e}`)); host.error(String(e && e.message || e)) })
      },
      /** After the view is in the page: follow a new step (animated), or keep the view (a size change re-centres). */
      placed() {
        if (!L) return
        const size = `${vw()}x${vh()}`
        if (followed !== cur) { const smooth = followed !== -1 && !!lastSize; lastSize = size; follow(smooth) }
        else if (size !== lastSize) { lastSize = size; follow(false) }
        else apply()
      },
      /**
       * The view changed width under the reader's hand (the splitter): what is on screen stays where it is (the map's
       * right edge is fixed); only if the current step's box would leave the view is it brought back.
       */
      resized() {
        if (!L || !lastSize) return
        const [w0] = lastSize.split('x').map(Number)
        const dw = vw() - w0
        lastSize = `${vw()}x${vh()}`
        const c = clamp(x + dw, y, k)
        x = c.x; y = c.y
        apply()
        const node = cur ? J.steps[cur - 1]?.node : undefined
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
