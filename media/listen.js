// The Listen view (src/podcast/listenView.ts): where a journey's audio plays; the page's script, bundled as
// out/pages/listen.js. A webview view VS Code keeps alive while
// hidden, so the episode goes on when the journey panel closes; the journey panel's player is a remote of this one.
// The view is there only while a journey is listened to: nothing to say before one is loaded.
// Shows the journey, the part being talked about, and the player (journey-podcast.js in host mode).
//
// The player starts as the audio's host; the extension makes it a remote while the journey panel plays the audio
// (podcastRole: journey-podcast.js's header says why).
//
// One player on screen: while the journey panel shows this episode (its player is the player), this view is one line,
// the journey, ⏸ / ▶ and the time; the whole player shows here only when the panel is closed.
//
// Its messages both ways are src/protocol/listen.ts (ToListen, FromListen): the player's, the journey the panel shows
// (`panel`) and the journey's map asked for (`podcastOpen`).
import { el, connect, onMessages } from './common.js'
import { JourneyPodcast } from './journey-podcast.js'

/** @typedef {import('../src/protocol/listen').ToListen} ToListen */
/** @typedef {import('../src/protocol/listen').FromListen} FromListen */

const { post } = /** @type {import('./types').Port<FromListen>} */ (connect())
const app = /** @type {HTMLElement} */ (document.getElementById('app'))

const head = el('div', 'ls-head')
const title = el('button', 'link ls-title')
title.title = 'Open the journey'
title.onclick = () => post({ type: 'podcastOpen' })
const where = el('div', 'ls-where')
head.append(title, where)
const mount = el('div', 'ls-player')
app.append(head, mount)

let ep
/** The journey the panel shows ('' : closed). */
let panelKey = ''
function compact() {
  const on = !!ep && panelKey === ep.key
  document.body.classList.toggle('compact', on)
  title.title = on ? 'Open the journey (its panel has the player)' : 'Open the journey'
}
const player = JourneyPodcast({
  post,
  mode: 'host',
  mount,
  onTick: (_t, step) => {
    const n = ep && ep.steps ? ep.steps.length : 0
    const s = step && ep && ep.steps[step - 1]
    const text = !ep ? '' : step ? `Step ${step} of ${n}${s ? ` · ${s.title}` : ''}` : ''
    if (where.textContent !== text) { where.textContent = text; where.title = text }
  },
})
/** An episode, or nothing (none, or one that can't be played: the journey panel says why). */
function show(e) {
  ep = e && !e.unavailable ? e : undefined
  title.textContent = ep ? ep.journey || ep.title || '' : ''
  head.hidden = !ep
  if (!ep) where.textContent = ''
  player.set(ep)
  compact()
}
show(undefined)

/** @type {import('./types').Handlers<ToListen>} */
const handlers = {
  podcast(m) { show(m.episode) },
  podcastCmd(m) { player.cmd(m) },
  podcastRole(m) { player.setRole(m) },
  podcastState(m) { player.hostState(m) },
  panel(m) { panelKey = m.key || ''; compact() },
  hello() { post({ type: 'ready' }) },
  test(m) {
    if (m.click) { const t = document.querySelector(m.click); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
  },
}
onMessages(handlers)
post({ type: 'ready' })
