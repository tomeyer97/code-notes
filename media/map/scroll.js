// Scrolling the panel: the current storyline row in view under the sticky header once per step change, and the step
// the voice moved to (unless the reader scrolled a moment ago).
/** A row closer than this (px) to the sticky header or the window's bottom is scrolled into view. */
const ROW_MARGIN = 4
/** Where a row scrolled into view lands: this far (px) under the header, or above the window's bottom. */
const ROW_TOP_GAP = 12, ROW_BOTTOM_GAP = 16
/** The podcast does not scroll the page for this long (ms) after the reader scrolled. */
const READER_SCROLL_MS = 2000

/** @param {import('./context.js').PanelContext} ctx */
export function makeScroll(ctx) {
  const { state, app } = ctx
  const view = state.view

  /** The sticky header, `head`, is in the page: its height kept, and given to the stylesheet (--headH). */
  function headerDrawn(head) {
    view.headH = head.offsetHeight
    document.documentElement.style.setProperty('--headH', `${view.headH}px`)
  }

  /** Once per step change: the current storyline row in view under the header (the map follows on its own). */
  function follow() {
    if (ctx.tutorial.card) return
    const { cur, tour } = state.walk
    const at = tour.stops.find((q) => q.cur)
    const k = `${cur}|${at ? at.id : ''}`
    if (!cur || k === view.scrolled) return
    view.scrolled = k
    const row = app.querySelector('.story .st.cur, .story .cp.cur')
    if (row) rowIntoView(row.getBoundingClientRect())
  }

  /** The voice moved to another step: the step's top in view (its animation, narrow; its row, wide). */
  function toVoice(L) {
    if (Date.now() - view.readerScrolled < READER_SCROLL_MS || !state.walk.cur) return
    const target = !L.wide && L.shown ? app.querySelector('.body > .mapwrap') : app.querySelector('.story .st.cur')
    if (!target) return
    window.scrollBy(0, target.getBoundingClientRect().top - view.headH - ROW_TOP_GAP)
  }

  /** Scrolls the page so row rectangle `r` (viewport px) is in view under the header: at the top when it was above
   *  or is taller than the room, else just up from the bottom. */
  function rowIntoView(r) {
    const top = view.headH
    const bottom = window.innerHeight - podcastBarHeight()
    const above = r.top < top + ROW_MARGIN
    if (!above && r.bottom <= bottom - ROW_MARGIN) return
    const atTop = above || r.height > bottom - top
    window.scrollBy(0, atTop ? r.top - top - ROW_TOP_GAP : r.bottom - bottom + ROW_BOTTOM_GAP)
  }

  return {
    headerDrawn,
    follow,
    toVoice,
    /** The reader scrolled by hand (the wheel, a touch). */
    readerScrolled() { view.readerScrolled = Date.now() },
  }
}

/** The podcast bar covers the bottom of the window: its height, as journey-podcast.js sets it (--podH). */
function podcastBarHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--podH')) || 0
}
