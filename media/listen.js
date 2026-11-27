// The Listen view (src/podcast/listenView.ts): where a journey's audio plays; the page's script, bundled as
// out/pages/listen.js. VS Code keeps the view alive while hidden, so the episode goes on when the journey panel
// closes. It is there only while a journey is listened to: nothing to say before one is loaded. It shows the journey,
// the part being talked about, and the player (journey-podcast.js), which starts as the audio's host.
//
// One player on screen: while the journey panel shows this episode, the panel's player is the one to use, and this
// view is one line (the journey, ⏸ / ▶ and the time).
//
// Its messages both ways are src/protocol/listen.ts (ToListen, FromListen).
import { el, connect, onMessages } from './common.js'
import { JourneyPodcast } from './journey-podcast.js'
import { runTestMessage } from './map/testHooks.js'

/** @typedef {import('../src/protocol/listen').ToListen} ToListen */
/** @typedef {import('../src/protocol/listen').FromListen} FromListen */
/** @typedef {import('../src/protocol/podcast').PodcastEpisode} PodcastEpisode */

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

/** @type {PodcastEpisode | undefined} */
let ep
/** The journey the panel shows ('': closed). */
let panelKey = ''
/** The journey panel shows this episode: its player is the one on screen. */
const panelShowsIt = () => !!ep && panelKey === ep.key
function compact() {
  const on = panelShowsIt()
  document.body.classList.toggle('compact', on)
  title.title = on ? 'Open the journey (its panel has the player)' : 'Open the journey'
}
/** "Step 3 of 7 · title" for the step being talked about ('' on the map's parts). */
function stepLine(step) {
  if (!ep || !step) return ''
  const s = ep.steps[step - 1]
  return `Step ${step} of ${ep.steps.length}${s ? ` · ${s.title}` : ''}`
}
const player = JourneyPodcast({
  post,
  mode: 'host',
  mount,
  onTick: (_t, step) => {
    const text = stepLine(step)
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
  test: runTestMessage,
}
onMessages(handlers)
post({ type: 'ready' })
