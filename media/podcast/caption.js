// The caption on the page: the part of the sentence being said (src/podcast/captions.ts cuts and times the parts;
// this measures where a third line would start), and the end's buttons in its place once the episode has ended.
import { el } from '../common.js'
import { captionParts, partAt } from '../../src/podcast/captions'
import { segmentAt } from './episode.js'

export class Caption {
  /** @param {import('./dom.js').PlayerDom} dom */
  constructor(dom) {
    this.dom = dom
    /** The parts of the segment shown, cached by episode, segment and width. */
    this.key = ''
    /** @type {import('../../src/podcast/captions').CaptionPart[]} */
    this.parts = []
  }

  /** Cut again on the next draw (a new width). */
  invalidate() { this.key = '' }
  /** A new episode: its caption and its end made again. */
  reset() {
    this.key = ''
    this.dom.endBox.dataset.key = ''
  }

  /** Whether some html fits two lines at width `w` (undefined with no width yet). */
  measure(w) {
    const m = this.dom.capMeasure
    if (!w) return undefined
    m.style.width = `${w}px`
    const lineH = parseFloat(getComputedStyle(m).lineHeight) || 18
    return (html) => { m.innerHTML = html; return m.offsetHeight <= lineH * 2 + 2 }
  }

  /**
   * The caption at second `t` of episode `ep`; at the end (`ended`), what next instead.
   * @param {{ replay: () => void, walk: () => void, next: () => void }} endActions
   */
  render(ep, t, ended, endActions) {
    const { endBox, cap, capText } = this.dom
    endBox.hidden = !ended
    cap.hidden = ended
    if (ended) { this.renderEnd(ep, endActions); return }
    const si = segmentAt(ep, t)
    const w = capText.clientWidth
    const key = `${ep.key}|${si}|${w}`
    if (key !== this.key) { this.key = key; this.parts = si >= 0 ? captionParts(ep.segments, si, this.measure(w)) : [] }
    const p = partAt(this.parts, t)
    const html = p ? p.html : ''
    if (capText.dataset.html !== html) {
      capText.dataset.html = html
      capText.innerHTML = html
    }
  }

  /** The end of the episode: what next, and nothing else (no timeline, no transport: Replay is the ▶). */
  renderEnd(ep, on) {
    const endBox = this.dom.endBox
    const key = ep.key + (ep.next ? ep.next.key : '')
    if (endBox.dataset.key === key) return
    endBox.dataset.key = key
    endBox.textContent = ''
    const acts = el('span', 'pod-end-a')
    const action = (cls, text, f) => { const b = el('button', `link ${cls}`, text); b.onclick = f; acts.append(b); return b }
    action('pod-replay', 'Replay', on.replay)
    action('pod-walk', 'Walk it yourself', on.walk)
    if (ep.next) action('pod-nextj', 'Next journey', on.next).title = `Listen to “${ep.next.title}”`
    endBox.append(acts)
  }
}
