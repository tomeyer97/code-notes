// The Listen view (src/podcast/listenView.ts): where a journey's audio plays. A webview view VS Code keeps alive while
// hidden, so the episode goes on when the journey panel closes; the journey panel's player is a remote of this one.
// Shows the journey, the part being talked about, and the player (journey-podcast.js in host mode). Needs common.js
// and journey-podcast.js before it.
//
// In: { type: 'podcast', episode? }  { type: 'podcastCmd', … } (journey-podcast.js)  { type: 'hello' }
// Out: { type: 'ready' }  journey-podcast.js's host messages  { type: 'podcastOpen' } (the journey's map)
;(function () {
  const { el, connect, onMessages } = window.common
  const { post } = connect()
  const app = document.getElementById('app')

  const head = el('div', 'ls-head')
  const title = el('button', 'link ls-title')
  title.title = 'Open the journey'
  title.onclick = () => post({ type: 'podcastOpen' })
  const where = el('div', 'ls-where')
  head.append(title, where)
  const empty = el('p', 'ls-empty', 'Nothing to listen to yet. A journey with a podcast has ▶ Listen on its row in the Journeys view.')
  const mount = el('div', 'ls-player')
  app.append(head, empty, mount)

  let ep
  const player = window.JourneyPodcast({
    post,
    mode: 'host',
    mount,
    keyPrefix: () => (ep && ep.keyPrefix) || "Ctrl+'",
    onTick: (_t, step) => {
      const n = ep && ep.steps ? ep.steps.length : 0
      const s = step && ep && ep.steps[step - 1]
      const text = !ep ? '' : step ? `Step ${step} of ${n}${s ? ` · ${s.title}` : ''}` : ''
      if (where.textContent !== text) { where.textContent = text; where.title = text }
    },
  })
  function show(e) {
    ep = e && !e.unavailable ? e : undefined
    title.textContent = e ? e.journey || e.title || '' : ''
    head.hidden = !e
    empty.hidden = !!e
    if (!ep) where.textContent = ''
    player.set(e)
  }
  show(undefined)

  onMessages({
    podcast(m) { show(m.episode) },
    podcastCmd(m) { player.cmd(m) },
    hello() { post({ type: 'ready' }) },
    test(m) {
      if (m.click) { const t = document.querySelector(m.click); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
    },
  })
  post({ type: 'ready' })
})()
