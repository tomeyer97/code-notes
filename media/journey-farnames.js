// The map's names when zoomed out (journey-graph.js `farNames`): a block of leaves, a system or a lone box gets its
// name (and its step numbers) at a size you can read, in screen space, where it overlaps nothing placed before it.
// Exports measure(names) and place(items, taken, ring, bounds).
import { overlapArea, edgesOf } from './common.js'

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
/** A lone box's name just under or over it: this far (px) from it. */
const LONE_GAP = 5

/**
 * A far name as drawn (journey-graph's draw.js): its element (`.gname`, its text in `.gnt`, its numbers' `.gfn`
 * chips), its box's id, its whole label, what it names (a block of leaves, a system, a lone box), its step numbers.
 * @typedef {{ el: HTMLElement, id: string, label: string, kind: 'inner' | 'outer' | 'leaf', nums: number[] }} FarName
 */
/**
 * One way to write a name: its text (lines split by \n) and its chip's size; `bare`: without its numbers, `row`: the
 * name and its numbers on one line, `line`: on two lines, the longer one's width.
 * @typedef {{ text: string, w: number, h: number, bare?: boolean, row?: boolean, line?: number }} Variant
 */
/** @typedef {{ whole: Variant, two: Variant[], cut: Variant[], row?: Variant, bare?: Variant, bareCut: Variant[] }} Variants */
/** @typedef {FarName & { variants: Variants }} MeasuredName */

// ---------- measuring: each name's variants ----------

/**
 * Each far name's variants, measured once (canvas text metrics: no reflow while panning): the whole name on one
 * line, on two lines (every split), and cut after a word with "…"; plus its numbers row. The fonts are the ones the
 * page styles the elements with.
 * @param {FarName[]} names @returns {MeasuredName[]}
 */
function measure(names) {
  const cv = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'))
  return names.map((n) => ({ ...n, variants: variantsOf(cv, n) }))
}

/** The font element `e` is drawn in, for the canvas. */
function fontOf(e) {
  const cs = getComputedStyle(e)
  return { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size: parseFloat(cs.fontSize) || 12 }
}

/** Far name `n`'s variants. @param {CanvasRenderingContext2D} cv @param {FarName} n @returns {Variants} */
function variantsOf(cv, n) {
  const { label } = n
  const nameFont = fontOf(/** @type {HTMLElement} */ (n.el.querySelector('.gnt')))
  const chip = n.el.querySelector('.gfn')
  const { nw, nh } = chip ? numbersSize(cv, fontOf(chip).font, n.nums) : { nw: 0, nh: 0 }
  cv.font = nameFont.font
  const tw = (s) => Math.ceil(cv.measureText(s).width) + TEXT_SLACK
  const words = label.split(/\s+/).filter(Boolean)
  const lineH = Math.ceil(nameFont.size * LINE_H)
  // A variant: its text on `lines` lines, `w` wide (its numbers row under it).
  const v = (text, lines, w) => ({ text, w: Math.max(w, nw) + CHIP_PAD, h: lines * lineH + nh + 2 })
  const whole = v(label, 1, tw(label))
  const cut = cutVariants(words, v, tw)
  // The name alone (its numbers left out) when the block is too small for both.
  const bare = (variant) => {
    if (!nh) return undefined
    return { text: variant.text, bare: true, w: tw(variant.text.split('\n')[0]) + CHIP_PAD, h: lineH + 2 }
  }
  // The name and its numbers on one line (a flat block).
  const rowW = tw(label) + 4 + nw + CHIP_PAD
  const row = nh ? { text: label, row: true, w: rowW, h: Math.max(lineH, NUMS_ROW_MIN_H) + 2 } : undefined
  return {
    whole,
    two: twoLineVariants(words, v, tw),
    cut,
    row,
    bare: bare(whole),
    bareCut: /** @type {Variant[]} */ (cut.map(bare).filter(Boolean)),
  }
}

/** The step numbers' row (`nums`, its chips in `font`): { nw, nh }. Leaves `cv`'s font on the chips'. */
function numbersSize(cv, font, nums) {
  cv.font = font
  const chipW = (v) => Math.max(NUM_MIN_W, Math.ceil(cv.measureText(String(v)).width) + NUM_PAD)
  const nw = nums.reduce((a, v) => a + chipW(v) + NUM_GAP, -NUM_GAP)
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
 * A place to try: `variant` at (x, y) (screen px); `wide`: it reads past its block's edges (on its chip).
 * @typedef {{ variant: Variant, wide: boolean, x: number, y: number }} Candidate
 */

/**
 * Where a far name may go on its box `blockRect` (screen px), in order. A system: its name at its top left. A lone
 * box: on it, else just under or over it. A block of leaves: blockCandidates.
 * @param {MeasuredName} name @param {{ x: number, y: number, w: number, h: number }} blockRect
 * @returns {Candidate[]}
 */
function candidatesFor(name, blockRect, isCurrentBlock) {
  const { kind, variants } = name
  if (kind === 'inner') return blockCandidates(variants, blockRect, isCurrentBlock)
  const B = blockRect
  const tries = []
  // A system's name may read past its box's right edge (on its chip) when nothing is there.
  const spots = kind === 'outer'
    ? [[B.x + 1, B.y + 1]]
    : [[B.x + 1, B.y + 1], [B.x + 1, B.y + B.h + LONE_GAP], [B.x + 1, B.y - variants.whole.h - LONE_GAP]]
  const room = kind === 'outer' ? B.w - 2 : Infinity
  const wide = kind === 'leaf'
  for (const [x, y] of spots) {
    tries.push({ variant: variants.whole, wide, x, y })
    const cut = variants.cut.find((v) => v.w <= room)
    if (cut) tries.push({ variant: cut, wide, x, y })
  }
  return tries
}

/**
 * A block of leaves: the variants tried, in this order (the order is the rule). Each but `outside` is tried centred
 * in the block, then at its top, then at its bottom (the current step's block also just under or over it):
 * whole inside it, on two lines, whole past its edges, name and numbers on one line, the name alone, cut after a
 * word, the name alone cut; last, just under or over it, so it still has a name.
 */
const BLOCK_ORDER = ['whole', 'two', 'wholeWide', 'row', 'bare', 'cut', 'bareCut', 'outside']

/**
 * Each entry of BLOCK_ORDER: the variant it tries (none: skipped) and whether it reads past the block. `inside`: the
 * width a variant may have inside the block.
 * @type {Record<string, (v: Variants, inside: number, blockRect: { h: number }) => { variant: Variant, wide: boolean } | undefined>}
 */
const BLOCK_VARIANT = {
  whole: (v, inside) => (v.whole.w <= inside ? { variant: v.whole, wide: false } : undefined),
  two: (v, inside, blockRect) => {
    const two = [...v.two].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)).find((t) => t.w <= inside && t.h <= blockRect.h - 2)
    return two && { variant: two, wide: false }
  },
  wholeWide: (v, inside) => (v.whole.w > inside ? { variant: v.whole, wide: true } : undefined),
  row: (v, inside) => v.row && { variant: v.row, wide: v.row.w > inside },
  bare: (v, inside) => v.bare && { variant: v.bare, wide: v.bare.w > inside },
  cut: (v, inside) => fitting(v.cut, inside),
  bareCut: (v, inside) => fitting(v.bareCut, inside),
}
/** The first of `list` no wider than `inside`. */
const fitting = (list, inside) => {
  const variant = list.find((v) => v.w <= inside)
  return variant && { variant, wide: false }
}

/** candidatesFor a block of leaves (BLOCK_ORDER). @returns {Candidate[]} */
function blockCandidates(variants, blockRect, isCurrentBlock) {
  const B = blockRect
  const inside = B.w - 4
  const centreX = (v) => B.x + B.w / 2 - v.w / 2
  const under = B.y + B.h + OUTSIDE_GAP
  const over = (h) => B.y - h - OUTSIDE_GAP
  // Centred, at the top, at the bottom; the current step's block also just under or over it (the ring is inside it).
  const ys = (h) => [B.y + B.h / 2 - h / 2, B.y + 2, B.y + B.h - h - 2, ...(isCurrentBlock ? [under, over(h)] : [])]
  const outside = [variants.whole, variants.bare].filter((v) => !!v)
    .flatMap((v) => [under, over(v.h)].map((y) => ({ variant: v, wide: true, x: centreX(v), y })))
  return BLOCK_ORDER.flatMap((name) => {
    if (name === 'outside') return outside
    const pick = BLOCK_VARIANT[name](variants, inside, B)
    return pick ? ys(pick.variant.h).map((y) => ({ ...pick, x: centreX(pick.variant), y })) : []
  })
}

/**
 * Places the far names `items` where each overlaps nothing in `taken` (screen rectangles { x, y, w, h }; each name
 * placed is added to it) nor the current step's `ring` (its screen rectangle, if shown), wholly inside `bounds` (the
 * drawing, when given: a name its edge cuts reads as another word). In rank order (0 first), bigger boxes first (`size`: the
 * box's area); a name with no free place is hidden. The current step's own names (rank 0) go over the ring rather
 * than nowhere.
 * @param {{ name: MeasuredName, blockRect: { x: number, y: number, w: number, h: number }, isCurrentBlock: boolean,
 *   rank: number, size: number }[]} items
 * @param {{ x: number, y: number, w: number, h: number }[]} taken
 * @param {{ x: number, y: number, w: number, h: number } | undefined} ring
 * @param {{ x: number, y: number, w: number, h: number }} [bounds] none: anywhere
 */
function place(items, taken, ring, bounds) {
  const clashes = (r, q) => overlapArea(edgesOf(r), edgesOf(q)) > 0
  const inside = (r) => !bounds || r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h
  const free = (r, { allowRing = false } = {}) => inside(r) && !taken.some((q) => clashes(r, q)) && (allowRing || !ring || !clashes(r, ring))
  const rectOf = (c) => ({ x: c.x, y: c.y, w: c.variant.w, h: c.variant.h })
  items.sort((a, b) => a.rank - b.rank || b.size - a.size)
  for (const { name, blockRect, isCurrentBlock, rank } of items) {
    const tries = candidatesFor(name, blockRect, isCurrentBlock)
    // Its step numbers matter most: rather over the ring than not at all.
    const pick = tries.find((c) => free(rectOf(c))) || (rank === 0 && ring ? tries.find((c) => free(rectOf(c), { allowRing: true })) : undefined)
    if (!pick) { name.el.style.display = 'none'; continue }
    show(name.el, pick)
    taken.push(rectOf(pick))
  }
}

/** Far name `t` drawn as candidate `pick`. @param {HTMLElement} t @param {Candidate} pick */
function show(t, pick) {
  t.style.display = ''
  const sp = /** @type {HTMLElement} */ (t.firstChild)
  if (sp.textContent !== pick.variant.text) sp.textContent = pick.variant.text
  t.classList.toggle('wide', pick.wide)
  const nums = /** @type {HTMLElement | null} */ (t.querySelector('.gfnums'))
  if (nums) nums.style.display = pick.variant.bare ? 'none' : ''
  t.classList.toggle('row', !!pick.variant.row)
  Object.assign(t.style, { left: `${pick.x}px`, top: `${pick.y}px` })
}

export { measure, place }
