// The map's boxes as elements: a holder's title, a leaf with its step numbers. draw.js draws them; measureBoxes()
// measures the same elements with the page's styles for the layout (journey-layout.js takes the sizes, not the DOM).
import { el } from '../common.js'

/** A box's title (a box that holds others). */
export function titleEl(n) { return el('div', `gtitle ${n.kind}`, n.label) }

/** A box that holds no other: its name and its step numbers. */
export function leafEl(n, nums) {
  const d = el('div', `gbox leaf ${n.kind}`)
  d.append(el('span', 'glbl', n.label))
  if (nums.length) {
    const s = el('span', 'gnums')
    for (const v of nums) { const b = el('button', 'gnum', String(v)); b.dataset.n = v; s.append(b) }
    d.append(s)
  }
  return d
}

/** An arrow's label. */
export function labelEl(text) { return el('div', 'glabel', text) }

/**
 * The layout's measure (journey-layout.js Measure): each element made as it is drawn, sized in a hidden box in the
 * page (its styles apply), then removed; done() removes the box.
 * @returns {import('../journey-layout.js').Measure}
 */
export function measureBoxes() {
  const box = el('div', 'gmeasure')
  document.body.append(box)
  const size = (e) => {
    box.append(e)
    const r = { w: Math.ceil(e.offsetWidth) + 1, h: Math.ceil(e.offsetHeight) }
    e.remove()
    return r
  }
  return {
    title: (n) => size(titleEl(n)),
    leaf: (n, nums) => size(leafEl(n, nums)),
    label: (text) => size(labelEl(text)),
    done: () => box.remove(),
  }
}
