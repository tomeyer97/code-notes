// The map's names when zoomed out (journey-graph.js `farNames`): a block of leaves, a system or a lone box gets its
// name (and its step numbers) at a size you can read, in screen space, where it overlaps nothing placed before it.
// Needs common.js. API: window.JourneyFarNames = { measure(names), place(items, taken, ringR) }
;(function () {
  const { overlapArea, edgesOf } = window.common

  /** A chip's padding, both sides together (px). */
  const CHIP_PAD = 8
  /** A name's line height, times its font size. */
  const LINE_H = 1.2
  /** A step number's chip: at least NUM_MIN_W wide, its text and NUM_PAD of padding; NUM_GAP between two; the row
   *  NUMS_H high. */
  const NUM_MIN_W = 16, NUM_PAD = 10, NUM_GAP = 3, NUMS_H = 18
  /** The name and its numbers on one line: at least this high (px). */
  const NUMS_ROW_MIN_H = 16
  /** A name's width as measured is rounded up and given this much more (px): never cut by a pixel. */
  const TEXT_SLACK = 2
  /** A name cut after a word keeps at least this many characters (never just "The…"). */
  const CUT_MIN = 6
  /** Just under or over a block: this far (px) from it. */
  const OUTSIDE_GAP = 3

  // ---------- measuring: each name's variants ----------

  /**
   * Each far name's variants, measured once (canvas text metrics: no reflow while panning): the whole name on one
   * line, on two lines (every split), and cut after a word with "…"; plus its numbers row. `names`: the element
   * holding the `.gname`s. Returns Map(.gname → { whole, two, cut, row, bare, bareCut, kind }).
   */
  function measure(names) {
    const cv = document.createElement('canvas').getContext('2d')
    const out = new Map()
    for (const t of names.querySelectorAll('.gname')) {
      const sp = t.querySelector('.gnt'), cs = getComputedStyle(sp)
      const nameFont = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      cv.font = nameFont
      const fs = parseFloat(cs.fontSize) || 12
      const tw = (s) => Math.ceil(cv.measureText(s).width) + TEXT_SLACK
      const label = sp.dataset.full || sp.textContent
      sp.dataset.full = label
      const words = label.split(/\s+/).filter(Boolean)
      const lineH = Math.ceil(fs * LINE_H)
      const { nw, nh } = numbersSize(cv, [...t.querySelectorAll('.gfn')])
      cv.font = nameFont
      // A variant: its text on `lines` lines, `w` wide (its numbers row under it).
      const v = (text, lines, w) => ({ text, w: Math.max(w, nw) + CHIP_PAD, h: lines * lineH + nh + 2 })
      const whole = v(label, 1, tw(label))
      const two = twoLineVariants(words, v, tw)
      const cut = cutVariants(words, v, tw)
      // The name alone (its numbers left out) when the block is too small for both.
      const bare = (vv) => {
        if (!nh) return undefined
        return { text: vv.text, bare: true, w: tw(vv.text.split('\n')[0]) + CHIP_PAD, h: lineH + 2 }
      }
      // The name and its numbers on one line (a flat block).
      const rowW = tw(label) + 4 + nw + CHIP_PAD
      const row = nh ? { text: label, row: true, w: rowW, h: Math.max(lineH, NUMS_ROW_MIN_H) + 2 } : undefined
      out.set(t, {
        whole,
        two,
        cut,
        row,
        bare: bare(whole),
        bareCut: cut.map(bare).filter(Boolean),
        kind: t.classList.contains('outer') ? 'outer' : t.classList.contains('leaf') ? 'leaf' : 'inner',
      })
    }
    return out
  }

  /** The step numbers' row (`nums`: its .gfn chips): { nw, nh } (0 × 0: none). Leaves `cv`'s font on the chips'. */
  function numbersSize(cv, nums) {
    if (!nums.length) return { nw: 0, nh: 0 }
    const cn = getComputedStyle(nums[0])
    cv.font = `${cn.fontWeight} ${cn.fontSize} ${cn.fontFamily}`
    const chipW = (b) => Math.max(NUM_MIN_W, Math.ceil(cv.measureText(b.textContent).width) + NUM_PAD)
    const nw = nums.reduce((a, b) => a + chipW(b) + NUM_GAP, -NUM_GAP)
    return { nw, nh: NUMS_H }
  }

  /** The name on two lines, split after each word in turn (`line`: its longer line's width). */
  function twoLineVariants(words, v, tw) {
    const out = []
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ')
      const line = Math.max(tw(a), tw(b))
      out.push({ ...v(`${a}\n${b}`, 2, line), line })
    }
    return out
  }

  /** The name cut after a word with "…", longest first. */
  function cutVariants(words, v, tw) {
    const out = []
    for (let i = words.length - 1; i >= 1; i--) {
      const a = `${words.slice(0, i).join(' ')}…`
      if (a.length > CUT_MIN) out.push(v(a, 1, tw(a)))
    }
    return out
  }

  // ---------- placing ----------

  /**
   * Where far name `f` may go on its block `B` (screen px), in order: each { vv: the variant, wide: it reads past the
   * block (on its chip), x, y }. A block of leaves (`inner`): whole inside it, on two lines, whole past its edges, the
   * name and numbers on one line, the name alone, cut after a word, the name alone cut; each centred, then at the
   * top, then at the bottom of the block (`own`: the current step's block, also just under or over it); last, just
   * under or over it, so it still has a name. A system: its name at its top left. A lone box: on it, else just
   * under or over it.
   */
  function candidatesFor(f, B, own) {
    if (f.kind === 'inner') return blockCandidates(f, B, own)
    const tries = []
    // A system's name may read past its box's right edge (on its chip) when nothing is there.
    const spots = f.kind === 'outer'
      ? [[B.x + 1, B.y + 1]]
      : [[B.x + 1, B.y + 1], [B.x + 1, B.y + B.h + 5], [B.x + 1, B.y - f.whole.h - 5]]
    const room = f.kind === 'outer' ? B.w - 2 : Infinity
    const wide = f.kind === 'leaf'
    for (const [sx, sy] of spots) {
      tries.push({ vv: f.whole, wide, x: sx, y: sy })
      const cut = f.cut.find((vv) => vv.w <= room)
      if (cut) tries.push({ vv: cut, wide, x: sx, y: sy })
    }
    return tries
  }

  /** candidatesFor a block of leaves. */
  function blockCandidates(f, B, own) {
    const tries = []
    const inside = B.w - 4
    const centreX = (vv) => B.x + B.w / 2 - vv.w / 2
    const under = B.y + B.h + OUTSIDE_GAP
    const over = (h) => B.y - h - OUTSIDE_GAP
    // Centred, at the top, at the bottom; the current step's block also just under or over it (the ring is inside it).
    const ys = (h) => [B.y + B.h / 2 - h / 2, B.y + 2, B.y + B.h - h - 2, ...(own ? [under, over(h)] : [])]
    const at = (vv, wide) => { for (const y of ys(vv.h)) tries.push({ vv, wide, x: centreX(vv), y }) }
    const firstFitting = (list) => list.find((vv) => vv.w <= inside)
    if (f.whole.w <= inside) at(f.whole, false)
    const two = [...f.two].sort((a, b) => a.line - b.line).find((vv) => vv.w <= inside && vv.h <= B.h - 2)
    if (two) at(two, false)
    if (f.whole.w > inside) at(f.whole, true)
    if (f.row) at(f.row, f.row.w > inside)
    if (f.bare) at(f.bare, f.bare.w > inside)
    const cut = firstFitting(f.cut)
    if (cut) at(cut, false)
    const bareCut = firstFitting(f.bareCut)
    if (bareCut) at(bareCut, false)
    // Last: just under (or over) its block.
    for (const vv of [f.whole, f.bare].filter(Boolean)) {
      for (const y of [under, over(vv.h)]) tries.push({ vv, wide: true, x: centreX(vv), y })
    }
    return tries
  }

  /**
   * Places the far names `items` ([{ t: the .gname, f: its variants, p: its box (world px, for its size), B: the box
   * on screen, own: the current step's block, rank: 0 first }]) where each overlaps nothing in `taken` (screen
   * rectangles { x, y, w, h }, added to as names are placed); `ringR`: the current step's ring (in `taken`). In rank
   * order, bigger boxes first; a name with no free place is hidden.
   */
  function place(items, taken, ringR) {
    const free = (r) => !taken.some((q) => overlapArea(edgesOf(r), edgesOf(q)) > 0)
    items.sort((a, b) => a.rank - b.rank || b.p.w * b.p.h - a.p.w * a.p.h)
    for (const { t, f, B, own, rank } of items) {
      const tries = candidatesFor(f, B, own)
      const firstFree = () => tries.find((o) => free({ x: o.x, y: o.y, w: o.vv.w, h: o.vv.h }))
      let pick = firstFree()
      // Its step numbers matter most: rather over the ring than not at all.
      if (!pick && rank === 0 && ringR) {
        const i = taken.indexOf(ringR)
        taken.splice(i, 1)
        pick = firstFree()
        taken.splice(i, 0, ringR)
      }
      if (!pick) { t.style.display = 'none'; continue }
      show(t, pick)
      taken.push({ x: pick.x, y: pick.y, w: pick.vv.w, h: pick.vv.h })
    }
  }

  /** Far name `t` drawn as candidate `pick`. */
  function show(t, pick) {
    t.style.display = ''
    const sp = t.firstChild
    if (sp.textContent !== pick.vv.text) sp.textContent = pick.vv.text
    t.classList.toggle('wide', pick.wide)
    const nums = t.querySelector('.gfnums')
    if (nums) nums.style.display = pick.vv.bare ? 'none' : ''
    t.classList.toggle('row', !!pick.vv.row)
    Object.assign(t.style, { left: `${pick.x}px`, top: `${pick.y}px` })
  }

  window.JourneyFarNames = { measure, place }
})()
