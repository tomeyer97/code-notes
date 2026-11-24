// The journey panel under test: one helper set for the checks of shoot.mjs. A Panel is a harness page at a width and
// in a theme; reset() loads the page again (nothing kept from the check before: state, scroll, size, motion) and
// every check opens what it needs. Failures are collected per run with the page's tag.
import path from 'node:path'
import { openHarness } from '../harness/page.mjs'

/** The page's size when a check starts (each check that changes it gets it back from the next reset). */
const HEIGHT = 900

export class Panel {
  /**
   * @param {import('playwright').Browser} browser
   * @param {{ harness: string, width: number, theme: string, helpers: string[], toMap: any, from: any, shots: string, fail: (m: string) => void }} o
   */
  constructor(browser, o) {
    Object.assign(this, o)
    this.browser = browser
    this.tag = `${o.width}-${o.theme}`
    /** @type {import('playwright').Page} */
    this.page = undefined
    /** Console errors and warnings, page errors, failed requests since the last reset. */
    this.errors = []
  }

  /** The harness page, fresh: the map jumps instead of animating (prefers-reduced-motion), so checks see where it ends
   *  up (one check animates on purpose). */
  async reset() {
    if (this.page) await this.page.close()
    const context = { deviceScaleFactor: 1, reducedMotion: 'reduce' }
    ;({ page: this.page, errors: this.errors } = await openHarness(this.browser, this.harness, {
      width: this.width, height: HEIGHT, theme: this.theme, warnings: true, failedRequests: true, context, timeout: 4000, initScripts: this.helpers, ready: true,
    }))
  }

  async close() { if (this.page) await this.page.close() }

  /** A problem, said with where it was seen. */
  problem(m) { this.fail(`${this.tag}: ${m}`) }

  /** The page's errors since the reset (console, page errors, failed requests), as problems. */
  async errorsSeen() {
    for (const e of await this.page.evaluate(() => window.__harness.errors)) this.problem(`page error ${e.message}`)
    for (const e of this.errors) this.problem(`console ${e}`)
  }

  send(m) { return this.page.evaluate((x) => window.postMessage(x, '*'), m) }
  /** What the page posted since the last call. */
  posted() { return this.page.evaluate(() => window.__harness.posted.splice(0)) }
  /**
   * Until the page has handled what was just sent or clicked and drawn it: two animation frames. Messages and clicks
   * are handled before the next frame and the map (prefers-reduced-motion) jumps in one; nothing checked here waits
   * on a timer.
   */
  settle() { return this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))) }

  /** A tour message (`info` over the defaults: messages.ts DEFAULT_TOUR and the home list), and its drawing. */
  async tour(info) {
    await this.send(this.toMap.tour(info))
    await this.settle()
  }

  /** Journey `j` sent (where its walk is: `info`) and its map laid out (ELK is async); the layout rules told about it. */
  async open(j, info = {}) {
    await this.page.evaluate((x) => { window.__harness.journey = x }, j)
    await this.posted()
    await this.send(this.toMap.journey(j, info))
    const rendered = this.from.rendered
    await this.page.waitForFunction((r) => window.__harness.posted.some((m) => m.type === r) || !document.querySelector('.gmap'), rendered, { timeout: 15000 })
    await this.settle()
  }

  /** A click on `sel`, which posts a message with `want`'s fields (`what` it is, for the failure). */
  async clickPosts(sel, want, what) {
    await this.posted()
    await this.page.click(sel)
    await this.settle()
    const m = await this.posted()
    if (!m.some((x) => Object.entries(want).every(([k, v]) => x[k] === v))) this.problem(`${what}: click ${sel} posted ${JSON.stringify(m)}, want ${JSON.stringify(want)}`)
    return m
  }

  /** The map's pan and zoom ({ x, y, k }), from its drawing's transform. */
  view() {
    return this.page.evaluate(() => {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(document.querySelector('.gworld')?.style.transform || '')
      return m ? { x: +m[1], y: +m[2], k: +m[3] } : null
    })
  }

  /** Where the first element matching `sel` is: { l, t, r, b, w, h }, null when there is none. */
  rect(sel) {
    return this.page.evaluate((q) => {
      const e = document.querySelector(q)
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
    }, sel)
  }

  /** The layout rules (layoutChecks.js) on what is shown now; in dark, the map text's contrast too. `current`: a step
   *  is being walked (its box must be ringed). */
  async check(what, { current = true } = {}) {
    await this.page.mouse.move(0, 0)
    for (const x of await this.page.evaluate((c) => window.__harness.mapLayoutProblems(c), current)) this.problem(`${what}: ${x}`)
    if (this.theme === 'dark') for (const x of await this.page.evaluate(() => window.__harness.mapTextContrast())) this.problem(`${what}: ${x}`)
  }

  /** Fit and the far view (layoutChecks.js farViewProblems): while walking, the current step ringed and lit. */
  async farCheck(what) {
    const cur = await this.page.evaluate(() => Number(document.querySelector('.story .st.cur')?.dataset.n || 0))
    for (const x of await this.page.evaluate(([dark, c]) => window.__harness.farViewProblems(dark, c), [this.theme === 'dark', cur])) this.problem(`${what}: ${x}`)
  }

  /** A picture of the page (the whole page with `full`) as <tag>-<name>.png, the mouse out of the way. */
  async shot(name, full = false) {
    if (!this.shots) return
    await this.page.mouse.move(0, 0)
    await this.page.screenshot({ path: path.join(this.shots, `${this.tag}-${name}.png`), fullPage: full })
  }

  /** The page at `height` px (the width kept). */
  resize(height) { return this.page.setViewportSize({ width: this.width, height }) }
}
