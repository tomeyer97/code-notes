// The journey map's layout, as data (journey-graph.js draws it and moves the view): systems contain their modules,
// modules their functions; every edge between its real ends, with its label. ELK (layered, hierarchical:
// out/vendor/elk.bundled.js, as window.ELK) places the boxes; an arrow between modules gets one curve of its own; each
// label goes where it covers least. The boxes are measured with the real styles first.
// Needs common.js, journeyModel.js (`exports`) for isGeneric, and ELK, loaded before it.
// API: window.JourneyLayout = { layout(j) → Promise<{ w, h, abs, titleH, kids, edges }>, signature(j), stepsOf(j),
//      titleEl(n), leafEl(n, nums), samples(edge), pathD(points), verb(label) }
;(function () {
  const { el } = window.common
  const M = window.exports

  // ---------- an arrow's label: a plain verb phrase ----------

  /** A duration's unit: ms, s, sec(s), second(s), m, min(s), minute(s), h, hour(s). */
  const UNIT = String.raw`(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)`
  /** A timing clause to the end: " every 3 s …", " after up to 10 min", " max. 5 s". */
  const TIMING = new RegExp(
    String.raw`\s+(?:every|each|after|within|in|for|up to|for up to|max\.?|at most)` + // the timing word
    String.raw`\s+(?:up to\s+)?[\d.]+\s*${UNIT}\b.*$`, // its duration, and the rest
    'i',
  )
  /** A duration anywhere: " 30 s". */
  const DURATION = new RegExp(String.raw`\s+[\d.]+\s*${UNIT}\b`, 'gi')
  /** An arrow label as a plain verb phrase: the first clause, without timings ("polls every 3 s, max 10 min" → "polls"). */
  const verb = (l) => l.split(/[;,(]/)[0].replace(TIMING, '').replace(DURATION, '').trim()

  // ---------- the layout (ELK) ----------

  /** ELK's settings for the whole map (the boxes' own padding is set per box). Spacings in px. */
  const ELK_OPTIONS = {
    // the algorithm: layered, top to bottom, boxes inside boxes laid out together, square arrows
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    // the order: the boxes and arrows as given (the path's order), where it can
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    // spacing
    'elk.spacing.nodeNode': '22',
    'elk.layered.spacing.nodeNodeBetweenLayers': '26',
    'elk.spacing.edgeNode': '14',
    'elk.spacing.edgeEdge': '10',
    'elk.layered.spacing.edgeNodeBetweenLayers': '14',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
    'elk.spacing.edgeLabel': '3',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.padding': '[top=8,left=8,bottom=8,right=8]',
  }

  /** What the layout depends on: a journey with the same signature reuses it. */
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
  /** Node id → the numbers of its steps. */
  function stepsOf(j) {
    const m = new Map()
    for (const s of j.steps) { if (!m.has(s.node)) m.set(s.node, []); m.get(s.node).push(s.n) }
    return m
  }

  /** A box's title (a box that holds others). */
  function titleEl(n) { const t = el('div', `gtitle ${n.kind}`, n.label); return t }
  /** A box that holds no other: its name and its step numbers. */
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
    const root = { id: '#root', layoutOptions: { ...ELK_OPTIONS }, children: (kids.get('') || []).map((n) => mk(n, 0)), edges: [] }
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

  // ---------- arrows between modules: one curve each ----------

  /** How far a curve may bend sideways (px) to pass no box, tried in this order: straight first. */
  const SIDE_OFFSETS = [0, -50, 50, -100, 100, -160, 160, -240, 240]

  /** The sides an arrow leaves box `s` by and enters box `t` by ('t' | 'b' | 'l' | 'r'): below or above when the boxes
   *  are clear of each other that way, else beside. */
  function sidesBetween(s, t) {
    if (t.y >= s.y + s.h + 6) return ['b', 't']
    if (t.y + t.h + 6 <= s.y) return ['t', 'b']
    return t.x >= s.x + s.w / 2 ? ['r', 'l'] : ['l', 'r']
  }
  /** The point at fraction `f` along side `side` of box `r`. */
  function sidePoint(r, side, f) {
    switch (side) {
      case 'b': return { x: r.x + r.w * f, y: r.y + r.h }
      case 't': return { x: r.x + r.w * f, y: r.y }
      case 'l': return { x: r.x, y: r.y + r.h * f }
      default: return { x: r.x + r.w, y: r.y + r.h * f }
    }
  }
  /** Point `p` (on side `p.side` of its box) moved `m` px away from the box. */
  function pushOut(p, m) {
    switch (p.side) {
      case 'b': return { x: p.x, y: p.y + m }
      case 't': return { x: p.x, y: p.y - m }
      case 'l': return { x: p.x - m, y: p.y }
      default: return { x: p.x + m, y: p.y }
    }
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
      const [ss, ts] = sidesBetween(s, t)
      ed.sides = [ss, ts]
      const add = (id, side, which, other) => {
        const k = `${id}|${side}`
        if (!ends.has(k)) ends.set(k, [])
        ends.get(k).push({ ed, which, key: side === 'b' || side === 't' ? other.x + other.w / 2 : other.y + other.h / 2 })
      }
      add(ed.e.from, ss, 0, t)
      add(ed.e.to, ts, 1, s)
    }
    for (const [k, list] of ends) {
      const [id, side] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)]
      const r = abs.get(id)
      list.sort((a, b) => a.key - b.key)
      list.forEach((x, i) => {
        const p = sidePoint(r, side, (i + 1) / (list.length + 1))
        ;(x.ed.anchor || (x.ed.anchor = []))[x.which] = { ...p, side }
      })
    }
    for (const ed of edges) {
      if (!ed.anchor || !ed.anchor[0] || !ed.anchor[1]) continue
      const [a, b] = ed.anchor
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const m = Math.max(20, Math.min(90, d / 2.5))
      // Only a curve that crosses no other box (a line under a box reads as an arrow into it): bent sideways as far as
      // needed; when none is clear, ELK's route.
      const vert = a.side === 'b' || a.side === 't'
      const leaves = [...abs].filter(([id]) => id !== ed.e.from && id !== ed.e.to && id !== '#root' && !(kidsOf.get(id) || []).length).map(([, r]) => r)
      const clear = (bz) => {
        const pts = samples({ bez: bz })
        return !leaves.some((r) => pts.some((q) => q.x > r.x - 6 && q.x < r.x + r.w + 6 && q.y > r.y - 6 && q.y < r.y + r.h + 6))
      }
      let bez
      for (const off of SIDE_OFFSETS) {
        const sh = (p) => (vert ? { x: p.x + off, y: p.y } : { x: p.x, y: p.y + off })
        const bz = [a, sh(pushOut(a, m)), sh(pushOut(b, m)), b]
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
      for (let i = 0; i <= 60; i++) {
        const t = i / 60, u = 1 - t
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        })
      }
      return out
    }
    const P = ed.pts
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4))
      for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
    }
    return out
  }

  // ---------- labels ----------

  /** Where along its arrow a label may sit (a fraction of its length), tried in this order: the middle first. */
  const LABEL_SPOTS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]

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
      for (const f of LABEL_SPOTS) {
        const p = pts[Math.round((pts.length - 1) * f)]
        const r = { x: p.x - ed.lw / 2, y: p.y - ed.lh / 2, w: ed.lw, h: ed.lh }
        // What it covers, and a little for being off the middle; covering nothing ends the search.
        const cost = obstacles.reduce((c, o) => c + area(r, o), 0) + Math.abs(f - 0.5) * 20
        if (cost < bestCost) { bestCost = cost; best = r }
        if (cost <= Math.abs(f - 0.5) * 20) break
      }
      ed.label = best
      obstacles.push(best)
    }
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

  window.JourneyLayout = { layout, signature, stepsOf, titleEl, leafEl, samples, pathD, verb }
})()
