// The timeline: one bar per part, filled as it plays; the step marks under it; the hover tip; a click or a drag
// seeks (once, where the drag ends); the slider's keys (the ARIA pattern).
import { el, runKey } from '../common.js'
import { CUT_S, END_GUARD_S, MARK_MIN_PX, SKIP_S } from './constants.js'
import { chapterAt } from './episode.js'
import { clock } from './format.js'

/**
 * What the timeline acts on.
 * @typedef {object} TimelineHost
 * @property {() => import('../../src/protocol/podcast').PodcastEpisode | undefined} episode
 * @property {() => { total(): number, reach(): number, seek(t: number): void, skip(by: number): void, part(dir: number): void }} player
 * @property {(ep: any, i: number, short?: boolean) => string} partName
 * @property {() => void} draw
 */

export class Timeline {
  /**
   * @param {import('./dom.js').PlayerDom} dom
   * @param {TimelineHost} host
   * @param {AbortSignal} signal  the document's and window's listeners go with it
   */
  constructor(dom, host, signal) {
    this.dom = dom
    this.host = host
    /** @type {number | undefined} a drag: the time it would seek to */
    this.dragT = undefined
    /** @type {{ el: HTMLElement, fill: HTMLElement, c: any }[]} */
    this.bars = []
    /** @type {{ el: HTMLElement, c: any, i: number }[]} */
    this.markEls = []
    this.drawnSec = -1
    this.pointer(signal)
    this.keys()
  }

  total() { return this.host.player().total() }

  /** The bars and marks of the episode (none: empty). */
  build() {
    const { track, marks, tl } = this.dom
    track.textContent = ''
    marks.textContent = ''
    this.bars = []
    this.markEls = []
    const ep = this.host.episode()
    if (!ep) return
    const d = this.total() || 1
    for (const [i, c] of ep.chapters.entries()) {
      const b = el('div', `pod-bar${c.step ? '' : ' map'}`)
      b.style.left = `${(c.start / d) * 100}%`
      b.style.width = `${(Math.max(0, Math.min(c.end, d) - c.start) / d) * 100}%`
      const fill = el('div', 'pod-fill')
      b.append(fill)
      track.append(b)
      this.bars.push({ el: b, fill, c })
      if (!c.step) continue
      const m = el('button', 'pod-mark')
      m.tabIndex = -1
      m.dataset.i = String(i)
      m.dataset.step = String(c.step)
      m.setAttribute('aria-label', `Go to ${this.host.partName(ep, i)}`)
      m.addEventListener('pointerdown', (e) => e.stopPropagation())
      m.onclick = () => { this.host.player().seek(c.start); tl.focus({ preventScroll: true }) }
      m.addEventListener('pointerenter', () => this.showTip(c.start, m.getBoundingClientRect().left + m.offsetWidth / 2, i))
      m.addEventListener('pointerleave', () => this.hideTip())
      marks.append(m)
      this.markEls.push({ el: m, c, i })
    }
    this.layoutMarks()
  }

  /** The step marks under the bar, ticks (the hover tip names the step): at their part's start, each at least
   *  MARK_MIN_PX wide, pushed apart where parts are narrower than that (then back from the end, so the last stays
   *  inside). */
  layoutMarks() {
    const W = this.dom.track.clientWidth
    if (!W || !this.markEls.length) return
    const d = this.total() || 1
    const want = this.markEls.map(({ c }) => ({ x: (c.start / d) * W, w: Math.max(MARK_MIN_PX, ((Math.min(c.end, d) - c.start) / d) * W) }))
    for (let k = 1; k < want.length; k++) want[k].x = Math.max(want[k].x, want[k - 1].x + MARK_MIN_PX)
    for (let k = want.length - 1; k >= 0; k--) {
      const limit = k + 1 < want.length ? want[k + 1].x : W
      want[k].x = Math.max(0, Math.min(want[k].x, limit - MARK_MIN_PX))
      want[k].w = Math.max(MARK_MIN_PX, Math.min(want[k].w, limit - want[k].x))
    }
    for (const [k, m] of this.markEls.entries()) {
      m.el.style.left = `${want[k].x}px`
      m.el.style.width = `${want[k].w}px`
    }
  }

  /**
   * The timeline at second `t` (`s`: what the player shows; `ci` the part, `name` its name): the bars filled to it,
   * its part's bar and mark current, the playhead, the part the audio can't reach (a cut file: greyed, said on
   * hover), and the slider's values (said again only when the second or the part changes).
   */
  render(t, s, ci, name, spokenText) {
    const { thumb, reachEl, tl } = this.dom
    const d = s.dur || 1
    for (const [i, b] of this.bars.entries()) {
      const c = b.c
      const f = Math.max(0, Math.min(1, (t - c.start) / Math.max(0.001, Math.min(c.end, d) - c.start)))
      b.fill.style.width = `${f * 100}%`
      b.el.classList.toggle('cur', i === ci)
    }
    for (const m of this.markEls) m.el.classList.toggle('cur', m.i === ci)
    thumb.style.left = `${(Math.min(t, d) / d) * 100}%`
    const cut = s.reach > 0 && s.reach < d - CUT_S
    reachEl.hidden = !cut
    if (cut) {
      reachEl.style.left = `${(s.reach / d) * 100}%`
      reachEl.style.right = '0'
      reachEl.title = `The audio ends at ${clock(s.reach)}`
    }
    const sec = Math.floor(t)
    if (sec !== this.drawnSec || tl.dataset.part !== String(ci)) {
      this.drawnSec = sec
      tl.dataset.part = String(ci)
      tl.setAttribute('aria-valuemin', '0')
      tl.setAttribute('aria-valuemax', String(Math.round(d)))
      tl.setAttribute('aria-valuenow', String(sec))
      tl.setAttribute('aria-valuetext', `${spokenText(t)} of ${spokenText(d)}${name ? `, ${name}` : ''}`)
    }
  }

  // ---------- hover, click, drag ----------

  timeAtX(x) {
    const r = this.dom.track.getBoundingClientRect()
    return (Math.max(0, Math.min(r.width, x - r.left)) / (r.width || 1)) * (this.total() || 0)
  }
  /** The tip: the time, then the step (wrapped, never cut), over the pointer; a ghost line on the track. */
  showTip(t, x, i) {
    const ep = this.host.episode()
    if (!ep) return
    const { tip, tl, ghost } = this.dom
    const ci = i !== undefined ? i : chapterAt(ep, t)
    // "Step 6 · title · 5:23"
    tip.textContent = ''
    tip.append(el('span', 'pod-tip-part', `${this.host.partName(ep, ci, true)} · ${clock(t)}`))
    const reach = this.host.player().reach()
    if (reach && t > reach + END_GUARD_S) tip.append(el('span', 'pod-tip-cut', 'the audio ends before this'))
    tip.hidden = false
    const r = tl.getBoundingClientRect()
    const w = tip.offsetWidth
    tip.style.left = `${Math.max(0, Math.min(r.width - w, x - r.left - w / 2))}px`
    ghost.hidden = false
    ghost.style.left = `${Math.max(0, Math.min(r.width, x - r.left))}px`
  }
  hideTip() {
    if (this.dragT !== undefined) return
    this.dom.tip.hidden = true
    this.dom.ghost.hidden = true
  }
  /** The drag ends: seeks where it ended (`commit`), or goes back to where the audio is. */
  endDrag(commit) {
    if (this.dragT === undefined) return
    const t = this.dragT
    this.dragT = undefined
    this.dom.root.classList.remove('dragging')
    this.hideTip()
    if (commit) this.host.player().seek(t)
    else this.host.draw()
  }

  /** @param {AbortSignal} signal */
  pointer(signal) {
    const { tl, tip, root } = this.dom
    const trackBox = /** @type {HTMLElement} */ (this.dom.track.parentElement)
    trackBox.addEventListener('pointermove', (e) => {
      const on = /** @type {HTMLElement | null} */ (e.target)
      if (!this.host.episode() || (on && on.closest && on.closest('.pod-mark'))) return
      const t = this.timeAtX(e.clientX)
      this.showTip(t, e.clientX)
      if (this.dragT !== undefined) { this.dragT = t; this.host.draw() }
    })
    tl.addEventListener('pointerleave', () => this.hideTip())
    // A webview can miss the leave (the pointer left the frame): the tip goes then too.
    const hide = () => this.hideTip()
    document.addEventListener('pointerleave', hide, { signal })
    document.addEventListener('pointermove', (e) => {
      if (!tip.hidden && this.dragT === undefined && !tl.contains(/** @type {Node} */ (e.target))) this.hideTip()
    }, { signal })
    window.addEventListener('blur', hide, { signal })
    document.addEventListener('visibilitychange', hide, { signal })
    tl.addEventListener('pointerdown', (e) => {
      if (!this.host.episode() || e.button !== 0) return
      e.preventDefault()
      tl.setPointerCapture(e.pointerId)
      tl.focus({ preventScroll: true })
      this.dragT = this.timeAtX(e.clientX)
      root.classList.add('dragging')
      this.host.draw()
    })
    tl.addEventListener('pointerup', () => this.endDrag(true))
    tl.addEventListener('pointercancel', () => this.endDrag(false))
    tl.addEventListener('lostpointercapture', () => this.endDrag(true))
  }

  /** The slider's keys (the ARIA pattern): ↑ → on, ↓ ← back (15 s); Home, End; Page Up / Down a step. */
  keys() {
    this.dom.tl.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const p = this.host.player()
      runKey(e, {
        Escape: this.dragT !== undefined && (() => this.endDrag(false)),
        Home: () => p.seek(0),
        End: () => p.seek(this.total()),
        PageUp: () => p.part(-1),
        PageDown: () => p.part(1),
        ArrowUp: () => p.skip(SKIP_S),
        ArrowDown: () => p.skip(-SKIP_S),
      }, true)
    })
  }
}
