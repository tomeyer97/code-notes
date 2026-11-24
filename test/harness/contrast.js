// WCAG contrast, inside a harness page: window.__harness.contrast (themes.js Harness). A shoot script installs it with
// page.addInitScript({ path }) and its checks (in page.evaluate) call it.
;(function () {
  /** A computed colour as [r, g, b, a], r g b 0-255 (`color(srgb r g b / a)`, what color-mix() computes to, scaled up). */
  const rgba = (c) => {
    const n = (c.match(/[\d.]+/g) || []).map(Number)
    const k = c.startsWith('color(') ? 255 : 1
    return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1]
  }

  /** The colour `top` (with its alpha) laid over the opaque colour `under`. */
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1)

  /**
   * What shows behind `e`: its and its ancestors' backgrounds, up to the first opaque one, laid over `under` (white).
   * `stop`: an ancestor whose background is not counted (an overlay's container: the caller says what is under it).
   */
  const backgroundOf = (e, { stop = null, under = [255, 255, 255, 1] } = {}) => {
    const layers = []
    for (let x = e; x && x !== stop; x = x.parentElement) {
      const c = rgba(getComputedStyle(x).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    return layers.reverse().reduce((u, t) => over(t, u), under)
  }

  /** WCAG relative luminance of an opaque colour. */
  const luminance = (c) => {
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }

  /** WCAG contrast ratio of two opaque colours (1 to 21). */
  const ratio = (a, b) => {
    const L1 = luminance(a), L2 = luminance(b)
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
  }

  const H = (window.__harness = window.__harness || {})
  H.contrast = { rgba, over, backgroundOf, luminance, ratio }
})()
