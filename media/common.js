// Shared by every webview, loaded before its own scripts: the journey panel (journey-map.js and what it loads) and the
// Check view (check.js, checkAnswer.js); also the scene player (test/journey-scene/player.html). Plain DOM, textContent
// only. Nothing here talks to the extension until a page calls `connect()`.
;(function () {
  const SVG = 'http://www.w3.org/2000/svg'

  /** `<tag class="cls">text</tag>`; no class when `cls` is empty, no text when `text` is undefined. */
  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  /** An SVG element with these attributes. */
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    return e
  }

  /** A button that runs `onClick` (its `onclick`). */
  function button(cls, label, onClick) {
    const b = el('button', cls, label)
    b.onclick = onClick
    return b
  }

  /** `nodes` with " · " between them, to append in one go: a row of actions read left to right. */
  function joinDots(...nodes) {
    return nodes.flatMap((n, i) => (i ? [' · ', n] : [n]))
  }

  /** The last part of a path ("api/store.js" → "store.js"). */
  function baseName(path) {
    return String(path || '').split('/').pop()
  }

  // ---------- numbers and rectangles ----------

  /** `v`, kept between `lo` and `hi` (`hi` wins when they cross). */
  function between(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
  }

  /** The area two rectangles ({ left, top, right, bottom }) have in common; 0: they don't overlap. */
  function overlapArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return Math.max(0, w) * Math.max(0, h)
  }

  /** A rectangle given as { x, y, w, h }, as { left, top, right, bottom } (overlapArea's). */
  function edgesOf(r) {
    return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h }
  }

  // ---------- the extension: messages both ways ----------

  /**
   * The page's channel to the extension (call it once: VS Code hands out one API per page). Errors the page throws are
   * posted as { type: 'error', message }.
   */
  function connect() {
    const vscode = acquireVsCodeApi()
    window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) }))
    return { vscode, post: (m) => vscode.postMessage(m) }
  }

  /** Messages from the extension: `handlers[m.type](m)`; a type with no handler goes to `other(m)` (when given). */
  function onMessages(handlers, other) {
    window.addEventListener('message', (ev) => {
      const m = ev.data
      const f = Object.hasOwn(handlers, m.type) ? handlers[m.type] : other
      if (f) f(m)
    })
  }

  // ---------- keys ----------

  /**
   * A key → action table: runs `keys[e.key]` when it is a function (an entry that is false, or missing, leaves the key
   * alone). A key it ran: its default prevented and, with `stop`, kept from going further. Returns whether it ran.
   */
  function runKey(e, keys, stop) {
    const f = Object.hasOwn(keys, e.key) ? keys[e.key] : undefined
    if (typeof f !== 'function') return false
    e.preventDefault()
    if (stop) e.stopPropagation()
    f()
    return true
  }

  /** `items[j]`, `j` kept inside the list: before the first, the first; past the last, the last. */
  function itemAt(items, j) {
    return items[Math.max(0, Math.min(items.length - 1, j))]
  }

  /**
   * Roving focus: the arrows move between `items` (a list or a toolbar, one Tab stop). From item `i`, the `prev` and
   * `next` keys (e.g. ArrowUp, ArrowDown) go one item back or on, Home and End to the first and the last;
   * `moveTo(item)` takes the keyboard there. `stop` as in runKey. Returns whether it ran.
   */
  function rovingKeys(e, items, i, { prev, next }, moveTo, stop) {
    const to = (j) => () => moveTo(itemAt(items, j))
    return runKey(e, { [prev]: to(i - 1), [next]: to(i + 1), Home: to(0), End: to(items.length - 1) }, stop)
  }

  // ---------- what a person would notice (for tests) ----------

  /** Marks element `e` as one the page's test report watches (a page passes `WATCHED` to overflowing()). */
  function watched(e) {
    e.dataset.watch = ''
    return e
  }
  /** The selector of the elements watched(). */
  const WATCHED = '[data-watch]'

  /** The elements of `selector` in `root` that stick out past the page's right edge, as `describe(e)` says them; and
   *  "the page scrolls sideways" when it does. */
  function overflowing(root, selector, describe) {
    const W = document.documentElement.clientWidth
    const out = [...root.querySelectorAll(selector)].filter((e) => e.getBoundingClientRect().right > W + 1).map(describe)
    if (document.documentElement.scrollWidth > W + 1) out.push('the page scrolls sideways')
    return out
  }

  // ---------- an understanding check's question ----------

  /**
   * A question's states (src/checkModel.ts QState) and how they look. Not answered yet it is "○" in the Check view's
   * list (a checklist: check.js `row`) but "? Why …" as a row of the journey storyline, among the numbered steps
   * (journey-map.js `stopRow`; docs/understanding-check.md, test/check-tour/shoot.mjs). `answered`: said so to a
   * screen reader in the storyline; `word`: said after the question there. Here because both webviews draw them.
   */
  const QSTATE = {
    todo: { icon: '○', storyIcon: '?' },
    ungraded: { icon: '…', word: 'checking' },
    pass: { icon: '✓', answered: true },
    restated: { icon: '✓', answered: true },
    retry: { icon: '↻', word: 'try again' },
    explained: { icon: '·', word: 'explained' },
  }

  window.common = {
    el, svgEl, button, joinDots, baseName, overlapArea, edgesOf, between, connect, onMessages, runKey, itemAt, rovingKeys,
    watched, WATCHED, overflowing, QSTATE,
  }
})()
