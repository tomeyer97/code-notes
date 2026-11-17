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

  window.common = { el, svgEl, button }
})()
