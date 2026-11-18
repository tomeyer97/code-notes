// The journey panel's layout rules, inside the harness page (shoot.mjs installs this file with page.addInitScript and
// its `check` calls window.mapLayoutProblems). Each rule is a function returning what it finds wrong, as sentences.
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

  /** Every box of the journey (window.__J, when the test set it) drawn, inside the box it belongs to. */
  function boxesInsideParents(byId) {
    const out = []
    const J = window.__J
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

  /** Parts of the old map (before 0.21) are gone. */
  function noOldParts() {
    return ['.crumbs', '.stub', '.note.more', '.note.idle', '.legend', '.eblock', '.pop'].filter((old) => document.querySelector(old)).map((old) => `old map part ${old} still drawn`)
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

  /** Things the panel no longer shows. */
  function nothingRemovedShown() {
    const gone = [['.summary', 'a summary under the question'], ['.st .later, .st .asked, .st .wasTag', 'tags in the storyline'], ['.tpos', 'a "1/6" beside the tutorial dots']]
    return gone.filter(([sel]) => document.querySelector(sel)).map(([, what]) => `${what} shown`)
  }

  /** Every layout rule on what is shown now; `wantCurrent`: a step is being walked (its box must be ringed). */
  window.mapLayoutProblems = (wantCurrent) => {
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
    out.push(...noOldParts(), ...storylineClear(map), ...nothingRemovedShown())
    return out
  }
})()
