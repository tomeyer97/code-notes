// The journey panel's layout rules, inside the harness page (shoot.mjs installs this file with page.addInitScript and
// calls window.__harness.mapLayoutProblems, mapTextContrast and farViewProblems: ../harness/themes.js Harness). Each
// rule is a function returning what it finds wrong, as sentences.
;(function () {
  const rect = (e) => e.getBoundingClientRect()
  /** Do rectangles a and b overlap by more than `m` px? */
  const overlap = (a, b, m = 1) => a.left < b.right - m && b.left < a.right - m && a.top < b.bottom - m && b.top < a.bottom - m
  const visible = (e) => getComputedStyle(e).visibility !== 'hidden'

  /** The page never scrolls sideways. */
  function noHorizontalOverflow() {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth ? [`horizontal overflow ${de.scrollWidth} > ${de.clientWidth}`] : []
  }

  /** Box text never cut (wide enough for its label and numbers), when near; boxes never overlap. */
  function boxesWholeAndApart(map, leaves) {
    const out = []
    if (!map.classList.contains('far')) {
      for (const x of leaves) {
        if (x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1) out.push(`box ${x.dataset.id}: content clipped (${x.scrollWidth}x${x.scrollHeight} in ${x.clientWidth}x${x.clientHeight})`)
      }
    }
    for (let i = 0; i < leaves.length; i++) {
      for (let k = i + 1; k < leaves.length; k++) {
        if (overlap(rect(leaves[i]), rect(leaves[k]))) out.push(`boxes ${leaves[i].dataset.id} and ${leaves[k].dataset.id} overlap`)
      }
    }
    return out
  }

  /** Every box of the journey (__harness.journey, when the test set it) drawn, inside the box it belongs to. */
  function boxesInsideParents(byId) {
    const out = []
    const J = window.__harness.journey
    if (!J) return out
    for (const n of J.nodes) {
      const e = byId.get(n.id), p = n.parent && byId.get(n.parent)
      if (!e) {
        out.push(`box ${n.id} is not drawn`)
        continue
      }
      if (!p) continue
      const a = rect(e), q = rect(p)
      if (a.left < q.left - 0.5 || a.right > q.right + 0.5 || a.top < q.top - 0.5 || a.bottom > q.bottom + 0.5) out.push(`box ${n.id} sticks out of ${n.parent}`)
    }
    return out
  }

  /** Is some point of the arrow `path` inside the rectangle `r` (1 px of slack)? */
  function lineCrosses(path, r) {
    const m = path.getScreenCTM(), len = path.getTotalLength()
    for (let d = 0; d <= len; d += 2) {
      const pt = path.getPointAtLength(d), q = new DOMPoint(pt.x, pt.y).matrixTransform(m)
      if (q.x >= r.left - 1 && q.x <= r.right + 1 && q.y >= r.top - 1 && q.y <= r.bottom + 1) return true
    }
    return false
  }

  /** Arrow labels (near only): something to say, whole, on their own line, over no box and no other label. */
  function labelsOnTheirLines(map, leaves) {
    const out = []
    if (map.classList.contains('far')) return out
    const labels = [...map.querySelectorAll('.glabel')]
    for (const l of labels) {
      const r = rect(l)
      if (!l.textContent || /^calls?(\s|$)/i.test(l.textContent)) out.push(`label "${l.textContent}" drawn (none or generic)`)
      if (l.scrollWidth > l.clientWidth + 1) out.push(`label "${l.textContent}" is cut`)
      for (const x of leaves) if (overlap(r, rect(x), 2)) out.push(`label "${l.textContent}" covers box ${x.dataset.id}`)
      const p = map.querySelector(`path.gedge[data-i="${l.dataset.i}"]`)
      if (p && !lineCrosses(p, r)) out.push(`label "${l.textContent}" is off its line`)
    }
    for (let i = 0; i < labels.length; i++) {
      for (let k = i + 1; k < labels.length; k++) {
        if (overlap(rect(labels[i]), rect(labels[k]), 2)) out.push(`labels "${labels[i].textContent}" and "${labels[k].textContent}" overlap`)
      }
    }
    return out
  }

  /** Far out: every name whole (no "Regi…"). */
  function farNamesWhole(map) {
    const out = []
    if (!map.classList.contains('far')) return out
    for (const t of map.querySelectorAll('.gname')) {
      const s = t.firstChild
      if (visible(t) && s.scrollWidth > s.clientWidth + 1) out.push(`far name "${s.textContent}" cut`)
    }
    return out
  }

  /** The current step's box ringed and in view. */
  function currentBoxInView(map) {
    const cur = map.querySelector('.gbox.current')
    if (!cur) return ['no box ringed for the current step']
    const a = rect(cur), v = rect(map.querySelector('.gstage'))
    if (a.left < v.left - 1 || a.right > v.right + 1 || a.top < v.top - 1 || a.bottom > v.bottom + 1) return [`the current box ${cur.dataset.id} is not in view`]
    return []
  }

  /** The controls (+ − Fit ?) are a row under the drawing; no box or arrow label shows under them. */
  function controlsUnderTheDrawing(map) {
    const ctl = map.querySelector('.gctl')
    if (!ctl || [...ctl.children].map((x) => x.textContent).join() !== '+,−,Fit,?') return [`map controls "${ctl && ctl.textContent}"`]
    const out = []
    const c = rect(ctl), st = rect(map.querySelector('.gstage'))
    if (c.top < st.bottom - 1) out.push('the map controls are over the drawing')
    // What shows of each box and label (the drawing clips the rest).
    const shownPart = (a) => ({ left: Math.max(a.left, st.left), right: Math.min(a.right, st.right), top: Math.max(a.top, st.top), bottom: Math.min(a.bottom, st.bottom) })
    for (const e of map.querySelectorAll('.gbox.leaf, .glabel')) {
      const a = shownPart(rect(e))
      if (a.right > a.left && a.bottom > a.top && overlap(a, c) && visible(e)) out.push(`"${e.textContent}" under the map controls`)
    }
    return out
  }

  /** The storyline beside or under the map, never over it; its rows never overflow. */
  function storylineClear(map) {
    const out = []
    const story = document.querySelector('.story')
    if (!story) return out
    if (map && overlap(rect(story), rect(map))) out.push('the storyline overlaps the map')
    for (const s of story.querySelectorAll('.st')) if (s.scrollWidth > s.clientWidth + 1) out.push(`storyline row ${s.dataset.n} overflows`)
    return out
  }

  /** What the panel stopped showing stays gone (as of 0.24, Nov 2026): the old map's parts, a summary under the
   *  question, tags on storyline rows, a "1/6" by the tutorial's dots. */
  const REMOVED = [
    ['.crumbs, .stub, .note.more, .note.idle, .legend, .eblock, .pop', 'a part of the old map (before 0.21)'],
    ['.summary', 'a summary under the question'],
    ['.st .later, .st .asked, .st .wasTag', 'tags in the storyline'],
    ['.tpos', 'a "1/6" beside the tutorial dots'],
  ]
  function nothingRemovedShown() {
    return REMOVED.filter(([sel]) => document.querySelector(sel)).map(([, what]) => `${what} shown`)
  }

  // ---------- text contrast (dark themes) ----------

  /** The contrast of `e`'s text with what is under it (`under`: the colour below its own backgrounds, up to `stop`),
   *  faded by its own and its ancestors' opacity (`faded`). */
  function contrastOf(e, { stop = null, under, faded = false } = {}) {
    const { rgba, over, backgroundOf, ratio } = window.__harness.contrast
    let a = 1
    if (faded) for (let x = e; x; x = x.parentElement) a *= Number(getComputedStyle(x).opacity)
    const bg = backgroundOf(e, { stop, under }), fg0 = rgba(getComputedStyle(e).color)
    return ratio(over([fg0[0], fg0[1], fg0[2], fg0[3] * a], bg), bg)
  }

  /** Map text at ≥ 4.5:1 (labels, numbers and names you are meant to read; faint ones are faint on purpose). */
  function mapTextContrast() {
    const out = []
    const near = '.gmap:not(.far)'
    for (const e of document.querySelectorAll(`${near} .glabel:not(.faint), ${near} .gnum:not(.cur), ${near} .gtitle, ${near} .glbl`)) {
      if (e.getClientRects().length === 0 || getComputedStyle(e).visibility === 'hidden') continue
      const r = contrastOf(e, { faded: true })
      if (r < 4.5) out.push(`"${e.textContent.trim()}" (${e.className}) contrast ${r.toFixed(2)}:1 < 4.5`)
    }
    return out
  }

  // ---------- Fit and the far view ----------

  /** The drawing centred in its area when it is smaller than it. */
  function mapCentred(map) {
    const out = []
    const M = rect(map.querySelector('.gstage')), W = rect(map.querySelector('.gworld'))
    if (W.width < M.width - 4 && Math.abs((W.left - M.left) - (M.right - W.right)) > 3) out.push(`map not centred across (${Math.round(W.left - M.left)} | ${Math.round(M.right - W.right)})`)
    if (W.height < M.height - 4 && Math.abs((W.top - M.top) - (M.bottom - W.bottom)) > 3) out.push(`map not centred down (${Math.round(W.top - M.top)} | ${Math.round(M.bottom - W.bottom)})`)
    return out
  }

  /** The far names shown: their element and their text on one line. */
  const farNames = (map) => [...map.querySelectorAll('.gname')]
    .filter((t) => getComputedStyle(t).display !== 'none' && t.getClientRects().length)
    .map((e) => ({ e, text: e.querySelector('.gnt').textContent.replace(/\n/g, ' '), r: rect(e) }))

  /** Far names never over each other. */
  function farNamesApart(names) {
    const out = []
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) if (overlap(names[i].r, names[j].r)) out.push(`far names "${names[i].text}" and "${names[j].text}" overlap`)
    }
    return out
  }

  /** Far names never under the map's buttons (what shows of them in the drawing). */
  function farNamesClearOfButtons(map, names) {
    const M = rect(map.querySelector('.gstage')), c = rect(map.querySelector('.gctl'))
    const shownPart = (r) => ({ left: Math.max(r.left, M.left), right: Math.min(r.right, M.right), top: Math.max(r.top, M.top), bottom: Math.min(r.bottom, M.bottom) })
    return names
      .filter((x) => { const r = shownPart(x.r); return r.right > r.left && r.bottom > r.top && overlap(r, c) })
      .map((x) => `far name "${x.text}" under the map's buttons`)
  }

  /** A far name cut only after a word ("Order…", never "Ord…er" or a one-letter "O…"); some names shown. */
  function farNamesCutWell(names) {
    const badly = (t) => /\S…\S/.test(t) || (/…$/.test(t) && !/\s/.test(t.slice(0, -1)) && t.length < 3)
    const out = names.filter((x) => badly(x.text)).map((x) => `far name "${x.text}" cut badly`)
    if (!names.length) out.push('far view with no names')
    return out
  }

  /** While walking (step `cur`), the current step's box ringed in view and its number shown lit. */
  function farRingVisible(map, cur) {
    const out = []
    const M = rect(map.querySelector('.gstage'))
    const g = map.querySelector('.gring')
    const gr = g && rect(g)
    if (!gr || getComputedStyle(g).display === 'none' || gr.right < M.left || gr.left > M.right || gr.bottom < M.top || gr.top > M.bottom) out.push('far: the current step is not ringed in view')
    const lit = [...map.querySelectorAll('.gfn.cur')].filter((b) => b.getClientRects().length && getComputedStyle(b.closest('.gname')).display !== 'none')
    if (!lit.some((b) => b.textContent === String(cur))) out.push(`far: step ${cur}'s number not shown lit`)
    return out
  }

  /** Far names and their step numbers at ≥ 4.5:1 over what is under them: the page or a block (they float over the
   *  map, not on its own background). */
  function farContrast(map, names) {
    const { rgba, over } = window.__harness.contrast
    const page = rgba(getComputedStyle(document.body).backgroundColor)
    const block = document.querySelector('.gcover')
    const cover = block ? over(rgba(getComputedStyle(block).backgroundColor), page) : page
    const out = []
    for (const { e: name } of names) {
      for (const e of [name.querySelector('.gnt'), ...name.querySelectorAll('.gfn:not(.cur)')]) {
        for (const under of [page, cover]) {
          const r = contrastOf(e, { stop: map, under })
          if (r < 4.5) { out.push(`far "${e.textContent}" at ${r.toFixed(2)}:1`); break }
        }
      }
    }
    return out
  }

  /** Every layout rule on what is shown now; `wantCurrent`: a step is being walked (its box must be ringed). */
  const H = (window.__harness = window.__harness || {})
  H.mapLayoutProblems = (wantCurrent) => {
    const out = [...noHorizontalOverflow()]
    const map = document.querySelector('.gmap')
    if (map) {
      const leaves = [...map.querySelectorAll('.gbox.leaf')]
      const groups = [...map.querySelectorAll('.gbox.group')]
      const byId = new Map([...leaves, ...groups].map((e) => [e.dataset.id, e]))
      out.push(...boxesWholeAndApart(map, leaves), ...boxesInsideParents(byId), ...labelsOnTheirLines(map, leaves), ...farNamesWhole(map))
      if (wantCurrent) out.push(...currentBoxInView(map))
      out.push(...controlsUnderTheDrawing(map))
    }
    out.push(...storylineClear(map), ...nothingRemovedShown())
    return out
  }
  /** Map text contrast (dark themes). */
  H.mapTextContrast = mapTextContrast
  /** Fit and the far view: the map centred; far out, names apart, clear of the buttons, cut well, readable (`dark`);
   *  walking (step `cur`), the current step ringed and its number lit. */
  H.farViewProblems = (dark, cur) => {
    const map = document.querySelector('.gmap')
    if (!map || !map.querySelector('.gworld')) return []
    const out = mapCentred(map)
    if (!map.classList.contains('far')) return out
    const names = farNames(map)
    out.push(...farNamesApart(names), ...farNamesClearOfButtons(map, names), ...farNamesCutWell(names))
    if (cur) out.push(...farRingVisible(map, cur))
    if (dark) out.push(...farContrast(map, names))
    return out
  }
})()
