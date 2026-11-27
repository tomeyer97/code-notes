// The journey's listening player: the caption, a timeline marked by step, and the controls. Two pages have one: the
// Listen view (listen.js) and the journey panel (journey-map.js). One of them plays the audio (the host), the other
// draws the host's state and asks it to act (a remote); the extension says which (podcastRole) and relays between
// them (src/podcast/audioHost.ts says why the host can move). Its messages are src/protocol/podcast.ts.
//
// Here the parts are put together: the elements (podcast/dom.js), the player of each role (podcast/players.js), the
// timeline (podcast/timeline.js), the caption (podcast/caption.js), the keys (podcast/keys.js). One draw paints them
// from the player's state on the next frame (podcast/frames.js); what drawing tells the extension or a screen reader
// runs after it (effects).
import { buildPlayer, icon } from './podcast/dom.js'
import { chapterAt, partNames, stepSpan } from './podcast/episode.js'
import { clock, nextRate, rateText, spoken, stepRate } from './podcast/format.js'
import { Frames } from './podcast/frames.js'
import { Caption } from './podcast/caption.js'
import { bindKeys } from './podcast/keys.js'
import { mediaKeys, nowPlaying } from './podcast/mediaSession.js'
import { HostPlayer, RemotePlayer } from './podcast/players.js'
import { Timeline } from './podcast/timeline.js'
import { sentencesOf } from '../src/podcast/captions'

/** @typedef {import('../src/protocol/podcast').FromPlayer} FromPlayer */
/** @typedef {import('../src/protocol/podcast').ToPlayer} ToPlayer */
/** @typedef {import('../src/protocol/podcast').PodcastEpisode} PodcastEpisode */
/** @typedef {import('../src/protocol/podcast').PodcastUnavailable} PodcastUnavailable */

/**
 * @typedef {object} PlayerOptions
 * @property {(m: FromPlayer) => void} post
 * @property {'host' | 'remote'} mode  the role it starts in
 * @property {HTMLElement} [mount]  where the player goes (default: fixed at the window's bottom)
 * @property {(n: number) => string} [stepTitle]  step `n`'s title when the episode has none
 * @property {() => number} [stepCount]
 * @property {(shown: boolean) => void} [onShown]  the player came (an episode) or went
 * @property {(on: boolean) => void} [onListening]  it shows playing, or no longer
 * @property {(t: number, step: number, playing: boolean) => void} [onTick]  drawn at second `t`, in step `step` (0: none)
 * @property {() => string} [keyPrefix]
 */

/** @param {PlayerOptions} opts */
export function JourneyPodcast(opts) {
  const { post } = opts
  const dom = buildPlayer(opts.mount)
  const { root, audio, playB, rateB } = dom
  /** Every listener on the document and the window, removed by destroy(). */
  const lifetime = new AbortController()
  const signal = lifetime.signal
  /** @type {PodcastEpisode | undefined} */
  let ep
  const partName = partNames(opts)
  const frames = new Frames(draw)

  /** The audio may play without a click here (one was made here, or it played): said once to the extension. */
  let unlocked = false
  const markUnlocked = () => { if (!unlocked) { unlocked = true; post({ type: 'podcastUnlocked' }) } }
  audio.addEventListener('play', markUnlocked, { signal })

  /** @type {import('./podcast/players.js').PlayerContext} */
  const ctx = {
    post,
    episode: () => ep,
    dragT: () => timeline.dragT,
    draw: () => frames.request(),
    animate: () => frames.loop(() => player.state().playing && !reduced()),
    rebuild: () => timeline.build(),
    focusPlay: () => playB.focus({ preventScroll: true }),
  }
  /** @type {HostPlayer | RemotePlayer} */
  let player = opts.mode !== 'remote' ? new HostPlayer(ctx, audio) : new RemotePlayer(ctx)
  const timeline = new Timeline(dom, { episode: () => ep, player: () => player, partName, draw: ctx.draw }, signal)
  const caption = new Caption(dom)
  const showNowPlaying = nowPlaying()
  const endActions = {
    replay: () => player.play(0),
    walk: () => { if (ep) post({ type: 'podcastEnd', of: ep.key, action: 'walk' }) },
    next: () => { if (ep) post({ type: 'podcastEnd', of: ep.key, action: 'next' }) },
  }

  // ---------- the controls ----------

  dom.whyB.onclick = () => post({ type: 'podcastWhy' })
  dom.prevB.onclick = () => player.part(-1)
  playB.onclick = () => player.toggle()
  dom.nextB.onclick = () => player.part(1)
  rateB.onclick = () => player.setRate(nextRate(player.state().rate || 1))
  bindKeys(root, () => !!ep, {
    toggle: () => player.toggle(),
    toggleMute: () => player.setMuted(!player.state().muted),
    speed: (dir) => player.setRate(stepRate(player.state().rate, dir)),
    skip: (by) => player.skip(by),
    part: (dir) => player.part(dir),
  }, signal)
  mediaKeys({
    play: () => player.play(),
    pause: () => player.pause(),
    skip: (by) => player.skip(by),
    part: (dir) => player.part(dir),
    seek: (t) => player.seek(t),
  }, signal)

  // ---------- drawing ----------

  /** The step said last (a screen reader's polite announcement, once per step change). */
  let saidWhere = ''

  /** Everything the player shows, from its state; then what that tells the extension and a screen reader. */
  function draw() {
    if (!ep) return
    const s = player.state()
    const t = s.t
    const ci = chapterAt(ep, t)
    const name = ci >= 0 ? partName(ep, ci) : ''
    const turnedOn = render(ep, s, ci, name)
    effects(ep, s, ci, name, turnedOn)
  }

  /** The DOM at state `s` (part `ci`, called `name`); true when the play button changed between ▶ and ⏸. */
  function render(e, s, ci, name) {
    const t = s.t
    const d = s.dur || 1
    const on = !!s.playing
    timeline.render(t, s, ci, name, spoken)
    dom.timeNow.textContent = clock(t)
    dom.timeTotal.textContent = ` / ${clock(d)}`
    root.classList.toggle('ended', !!s.ended)
    const changed = playB.dataset.on !== String(on)
    if (changed) {
      playB.dataset.on = String(on)
      playB.textContent = ''
      playB.append(icon(on ? 'pause' : 'play'))
      root.classList.toggle('on', on)
    }
    const playLabel = s.ended ? 'Replay' : on ? 'Pause' : 'Play'
    playB.title = `${playLabel} (Space)`
    playB.setAttribute('aria-label', playLabel)
    rateB.textContent = rateText(s.rate || 1)
    rateB.setAttribute('aria-label', `Speed, ${rateText(s.rate || 1)}`)
    // The error or note line.
    dom.err.textContent = s.err || ''
    dom.err.title = dom.err.textContent
    dom.err.hidden = !dom.err.textContent
    dom.err.classList.toggle('note', !!s.note)
    caption.render(e, t, !!s.ended, endActions)
    return changed
  }

  /** What a draw tells others: the page (onListening, onTick), a screen reader (the step, said once when it changes
   *  while playing), and for the host the extension (each second shown) and the system's "now playing". */
  function effects(e, s, ci, name, turnedOn) {
    const on = !!s.playing
    if (turnedOn && opts.onListening) opts.onListening(on)
    if (on && name && name !== saidWhere) dom.live.textContent = name
    saidWhere = name
    if (opts.onTick) opts.onTick(s.t, ci >= 0 ? e.chapters[ci].step : 0, on)
    if (player.role === 'host') {
      player.drawn(on)
      showNowPlaying(e, ci, name)
    }
  }

  // The player's height, for the panel's layout (the map's column and the page's end stay clear of it); the marks
  // laid out again at a new width. Set a frame later, and only when it changed: set inside the observer it resized
  // the map, whose own observer then looped ("ResizeObserver loop completed with undelivered notifications").
  let podH = ''
  let markW = 0
  const setPodH = (h) => { podH = h; document.documentElement.style.setProperty('--podH', h) }
  const resized = new ResizeObserver(() => requestAnimationFrame(() => {
    if (dom.track.clientWidth !== markW) { markW = dom.track.clientWidth; timeline.layoutMarks(); caption.invalidate(); draw() }
    if (opts.mount) return
    const h = root.hidden ? '0px' : `${root.offsetHeight}px`
    if (h !== podH) setPodH(h)
  }))
  resized.observe(root)

  // The first click or key here unlocks this page's <audio> for good: load() with no source, inside the event (the
  // browser lets an element play once a gesture in its own page has touched it). With a source loaded, the ▶ that
  // plays it unlocks it (play() in the click). Only a real gesture counts (userActivation), not a script's event.
  // VS Code's window lets an <audio> play only once a click or a key in its own webview started it.
  function unlockNow() {
    if (unlocked || !navigator.userActivation || !navigator.userActivation.isActive) return
    if (audio.getAttribute('src')) return
    audio.load()
    markUnlocked()
  }
  for (const k of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup']) document.addEventListener(k, unlockNow, { capture: true, signal })

  // ---------- the episode and the role ----------

  /** The episode (none: the player goes; host: the same journey's same audio again keeps playing).
   *  @param {PodcastEpisode | PodcastUnavailable | undefined} given */
  function set(given) {
    const unavailable = given && 'unavailable' in given ? given.unavailable : ''
    const notice = given && 'notice' in given ? given.notice : ''
    dom.note.hidden = !(notice || unavailable)
    dom.noteText.textContent = unavailable ? 'Podcast unavailable' : notice || ''
    dom.note.title = unavailable || notice || ''
    root.classList.toggle('unavail', !!unavailable)
    const e = given && !('unavailable' in given) ? given : undefined
    if (!e) {
      if (player.role === 'host') player.unload()
      ep = undefined
      root.hidden = !unavailable
      if (!opts.mount) document.body.classList.toggle('has-pod', !!unavailable)
      if (!unavailable && !opts.mount) setPodH('0px')
      if (playB.dataset.on === 'true' && opts.onListening) opts.onListening(false)
      playB.dataset.on = ''
      root.classList.remove('on')
      if (opts.onShown) opts.onShown(false)
      return
    }
    const same = !!ep && ep.key === e.key && ep.src === e.src
    if (!same) player.leave()
    ep = e
    root.hidden = false
    if (!opts.mount) document.body.classList.add('has-pod')
    if (!same) player.start(e, { at: e.at || 0, play: e.play, until: undefined, rate: e.rate, muted: e.muted })
    caption.reset()
    timeline.build()
    // Drawn now, not on the next frame: what it showed of the episode before is never shown with this one.
    draw()
    if (player.role === 'host') player.postState()
    if (opts.onShown) opts.onShown(true)
  }

  /** This player becomes the host (its episode loaded, at `m.at`, playing if `m.play`) or a remote.
   *  @param {Extract<ToPlayer, { type: 'podcastRole' }>} m */
  function setRole(m) {
    const toHost = m.role === 'host'
    if (toHost === (player.role === 'host')) {
      if (toHost && ep && m.play) player.play(typeof m.at === 'number' ? m.at : undefined, typeof m.until === 'number' ? m.until : undefined)
      return
    }
    if (player.role === 'host') {
      // What it showed stays (as a remote's state) until the new host says where it is.
      const s = player.state()
      player.dispose()
      player = new RemotePlayer(ctx, { t: s.t, rate: s.rate, muted: s.muted, ready: s.ready, ended: s.ended, dur: s.dur, reach: s.reach })
      draw()
      return
    }
    const was = player.R
    player.dispose()
    const host = new HostPlayer(ctx, audio)
    player = host
    if (!ep) return
    host.start(ep, {
      at: typeof m.at === 'number' ? m.at : was.t || ep.at || 0,
      play: m.play,
      until: typeof m.until === 'number' ? m.until : undefined,
      rate: was.rate || ep.rate || 1,
      muted: was.muted,
    })
    draw()
    host.postState()
  }

  return {
    el: root,
    set,
    /** The extension's choice: this player the audio's host, or a remote (podcastRole). */
    setRole,
    /** The extension's command: the host's (`focus` either way). @param {Extract<ToPlayer, { type: 'podcastCmd' }>} m */
    cmd(m) {
      if (m.action === 'focus') { ctx.focusPlay(); return }
      if (ep && player.role === 'host') player.command(m)
    },
    /** The host's state (a remote draws it). @param {Extract<ToPlayer, { type: 'podcastState' }>} m */
    hostState(m) { if (player.role === 'remote') player.hostState(m) },
    /** Plays one step and stops at its end (▶ on a storyline row). */
    playStep(n) {
      const span = ep && stepSpan(ep, n)
      if (span) player.play(span.start, span.end)
    },
    /** Plays from second `t` (the intro's or the recap's row). */
    playFrom(t) { player.play(t) },
    /** To second `t` (a sentence of the transcript). */
    seek(t) { player.seek(t) },
    /** The episode shown (the storyline's chapter list reads it). */
    get episode() { return ep },
    /** The time and the playing state shown. */
    get now() { const s = player.state(); return { t: s.t, playing: !!s.playing, ended: !!s.ended } },
    sentencesOf,
    get shown() { return !!ep },
    /** The journey's titles changed (another journey of the same id, a rename): the tip and labels follow. */
    redraw() { if (ep) { timeline.build(); ctx.draw() } },
    /** The player gone: its audio unloaded, its listeners and timers removed. */
    destroy() {
      lifetime.abort()
      frames.cancel()
      resized.disconnect()
      player.dispose()
      root.remove()
    },
  }
}

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
