// The player's elements: built once, in the order they show (a note, the caption, the end, the timeline, the
// controls, the error line), with their roles and labels; the parts no role names carry a data-testid (the
// screenshot checks find them by it, not by their classes). Nothing here acts: journey-podcast.js wires them.
import { el, svgEl } from '../common.js'

const PATHS = {
  play: 'M5 3.5v13l11-6.5z',
  pause: 'M5 3h3.5v14H5zM11.5 3H15v14h-3.5z',
  prev: 'M4 3h2v14H4zM16 3v14L7 10z',
  next: 'M14 3h2v14h-2zM4 3v14l9-7z',
}
/** @param {keyof typeof PATHS} name */
export function icon(name) {
  const s = svgEl('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true' })
  s.append(svgEl('path', { d: PATHS[name], fill: 'currentColor' }))
  return s
}

/** A control button: its tooltip `label` (the key in brackets), its accessible name the label without the key. */
function button(cls, label, child) {
  const b = el('button', `pod-b ${cls}`)
  b.title = label
  b.setAttribute('aria-label', label.replace(/ \(.*\)$/, ''))
  b.append(child)
  return b
}

/** The player's elements, in `mount` (default: fixed at the window's bottom). */
export function buildPlayer(mount) {
  const root = el('div', `pod${mount ? ' inline' : ''}`)
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Listen')
  root.hidden = true
  const audio = el('audio')
  audio.preload = 'metadata'

  // What is wrong with the podcast (or that it can't be played), and the way to the details.
  const note = el('div', 'pod-note')
  note.hidden = true
  const noteText = el('span', 'pod-note-t')
  noteText.dataset.testid = 'note'
  const whyB = el('button', 'link pod-why', 'Show why')
  note.append(noteText, whyB)

  // The caption: the sentence being said, two lines at most (a long one in parts), the speaker when the voice changes.
  const cap = el('div', 'pod-cap')
  const capText = el('div', 'pod-cap-t')
  capText.dataset.testid = 'caption'
  const capMeasure = el('div', 'pod-cap-t pod-cap-m')
  capMeasure.setAttribute('aria-hidden', 'true')
  cap.append(capText, capMeasure)
  // The end: what next.
  const endBox = el('div', 'pod-end')
  endBox.dataset.testid = 'end'
  endBox.hidden = true

  // The timeline: one bar per part (step), filled as it plays; the playhead; the step marks under it; the hover tip.
  const tl = el('div', 'pod-tl')
  tl.tabIndex = 0
  tl.setAttribute('role', 'slider')
  tl.setAttribute('aria-label', 'Position')
  const track = el('div', 'pod-track')
  const reachEl = el('div', 'pod-reach')
  reachEl.hidden = true
  const ghost = el('div', 'pod-ghost')
  ghost.hidden = true
  const thumb = el('div', 'pod-thumb')
  const marks = el('div', 'pod-marks')
  const tip = el('div', 'pod-tip')
  tip.dataset.testid = 'tip'
  tip.hidden = true
  tl.append(track, reachEl, ghost, thumb, marks, tip)

  const prevB = button('prev', 'Previous step (Shift+←)', icon('prev'))
  const playB = button('play', 'Play', icon('play'))
  const nextB = button('next', 'Next step (Shift+→)', icon('next'))
  const time = el('span', 'pod-time')
  time.dataset.testid = 'time'
  const timeNow = el('span', 'pod-now')
  const timeTotal = el('span', 'pod-total')
  timeTotal.dataset.testid = 'total'
  time.append(timeNow, timeTotal)
  // The speed: "1×", a click goes to the next (1 → 1.25 → 1.5 → 2 → 1). No mute button (M mutes; the system's volume
  // is the volume).
  const rateB = el('button', 'pod-rate', '1×')
  rateB.title = 'Speed'
  // An error, or a note ("not in the podcast"): one short line under the controls.
  const err = el('div', 'pod-err')
  err.hidden = true
  err.setAttribute('role', 'status')
  const row = el('div', 'pod-row')
  const ctl = el('div', 'pod-ctl')
  ctl.append(prevB, playB, nextB)
  const opt = el('div', 'pod-opt')
  opt.append(rateB)
  row.append(ctl, time, opt)
  // Said once per step change (a screen reader's polite announcement), never per frame.
  const live = el('div', 'pod-sr')
  live.setAttribute('aria-live', 'polite')
  root.append(note, cap, endBox, tl, row, err, live, audio)
  ;(mount || document.body).append(root)
  return { root, audio, note, noteText, whyB, cap, capText, capMeasure, endBox, tl, track, reachEl, ghost, thumb, marks, tip, prevB, playB, nextB, timeNow, timeTotal, rateB, err, live }
}

/** @typedef {ReturnType<typeof buildPlayer>} PlayerDom */
