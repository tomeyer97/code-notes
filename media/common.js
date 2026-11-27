// Shared by every page: the journey panel (journey-map.js and what it imports), the Listen view (listen.js) and the
// Check view (check.js, checkAnswer.js); also the scene player (test/journey-scene/player.html). Plain DOM, textContent
// only. Nothing here talks to the extension until a page calls `connect()`; what a page and the extension say to each
// other is typed in src/protocol/ (one union each way per page).
const SVG = 'http://www.w3.org/2000/svg'

/**
 * `<tag class="cls">text</tag>`; no class when `cls` is empty, no text when `text` is undefined.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | null} [cls]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * An SVG element with these attributes.
 * @template {keyof SVGElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any>} attrs
 * @returns {SVGElementTagNameMap[K]}
 */
export function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG, tag)
  for (const k in attrs) e.setAttribute(k, attrs[k])
  return e
}

/**
 * A button that runs `onClick` (its `onclick`).
 * @param {string} cls
 * @param {string | undefined} label
 * @param {(e: MouseEvent) => void} onClick
 */
export function button(cls, label, onClick) {
  const b = el('button', cls, label)
  b.onclick = onClick
  return b
}

/**
 * `nodes` with " · " between them, to append in one go: a row of actions read left to right.
 * @param {...(Node | string)} nodes
 */
export function joinDots(...nodes) {
  return nodes.flatMap((n, i) => (i ? [' · ', n] : [n]))
}

/**
 * The last part of a path ("api/store.js" → "store.js").
 * @param {string | undefined} path
 * @returns {string}
 */
export function baseName(path) {
  return String(path || '').split('/').pop() || ''
}

// ---------- numbers and rectangles ----------

/**
 * `v`, kept between `lo` and `hi` (`hi` wins when they cross).
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
export function between(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Edges */

/**
 * The area two rectangles ({ left, top, right, bottom }) have in common; 0: they don't overlap.
 * @param {Edges} a
 * @param {Edges} b
 */
export function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return Math.max(0, w) * Math.max(0, h)
}

/**
 * A rectangle given as { x, y, w, h }, as { left, top, right, bottom } (overlapArea's).
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @returns {Edges}
 */
export function edgesOf(r) {
  return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h }
}

// ---------- the extension: messages both ways ----------

/**
 * The page's channel to the extension (call it once: VS Code hands out one API per page). Errors the page throws are
 * posted as { type: 'error', message }. What the page posts is its protocol's union: the page casts the result to
 * Port<that union> (journey-map.js: Port<FromMap>).
 * @returns {import('./types').Port<{ type: string }>}
 */
export function connect() {
  const vscode = acquireVsCodeApi()
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) }))
  return { vscode, post: (m) => vscode.postMessage(m) }
}

/**
 * Messages from the extension: `handlers[m.type](m)`; a type with no handler goes to `other(m)` (when given).
 * Without `other`, `handlers` has one handler for every type of `In`.
 * @template {{ type: string }} In
 * @param {import('./types').Handlers<In> | Partial<import('./types').Handlers<In>>} handlers
 * @param {(m: In) => void} [other]
 */
export function onMessages(handlers, other) {
  window.addEventListener('message', (ev) => {
    /** @type {In} */
    const m = ev.data
    /** @type {((m: any) => void) | undefined} */
    const f = Object.hasOwn(handlers, m.type) ? /** @type {any} */ (handlers)[m.type] : other
    if (f) f(m)
  })
}

// ---------- keys ----------

/**
 * A key → action table: runs `keys[e.key]` when it is a function (an entry that is false, or missing, leaves the key
 * alone). A key it ran: its default prevented and, with `stop`, kept from going further. Returns whether it ran.
 */
export function runKey(e, keys, stop) {
  const f = Object.hasOwn(keys, e.key) ? keys[e.key] : undefined
  if (typeof f !== 'function') return false
  e.preventDefault()
  if (stop) e.stopPropagation()
  f()
  return true
}

/** `items[j]`, `j` kept inside the list: before the first, the first; past the last, the last. */
export function itemAt(items, j) {
  return items[Math.max(0, Math.min(items.length - 1, j))]
}

/**
 * Roving focus: the arrows move between `items` (a list or a toolbar, one Tab stop). From item `i`, the `prev` and
 * `next` keys (e.g. ArrowUp, ArrowDown) go one item back or on, Home and End to the first and the last;
 * `moveTo(item)` takes the keyboard there. `stop` as in runKey. Returns whether it ran.
 */
export function rovingKeys(e, items, i, { prev, next }, moveTo, stop) {
  const to = (j) => () => moveTo(itemAt(items, j))
  return runKey(e, { [prev]: to(i - 1), [next]: to(i + 1), Home: to(0), End: to(items.length - 1) }, stop)
}
