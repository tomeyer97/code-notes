// What the player's controls act on, one object per role with the same methods (play, pause, seek, skip, part,
// setRate, setMuted, now, state): the host plays the <audio> and says where it is; a remote draws what the host last
// said and asks it, through the extension, to act. journey-podcast.js swaps one for the other when the extension
// changes the roles (podcastRole).
import { ASK_STALE_MS, BOUNDARY_LATE_MS, END_GUARD_S, FROZEN_MS, MISS_S, NEXT_SEGMENT_S, REPLAY_GUARD_S, UNTIL_GUARD_S } from './constants.js'
import { partStart } from './episode.js'
import { clock, knownRate } from './format.js'

/** @typedef {import('../../src/protocol/podcast').FromPlayer} FromPlayer */
/** @typedef {import('../../src/protocol/podcast').PodcastEpisode} PodcastEpisode */
/** @typedef {import('../../src/protocol/podcast').PodcastHostState} PodcastHostState */
/** @typedef {Extract<import('../../src/protocol/podcast').ToPlayer, { type: 'podcastCmd' }>} PodcastCommand */
/** @typedef {Extract<import('../../src/protocol/podcast').ToPlayer, { type: 'podcastRole' }>} PodcastRole */

/**
 * What both roles get from the player around them.
 * @typedef {object} PlayerContext
 * @property {(m: FromPlayer) => void} post
 * @property {() => PodcastEpisode | undefined} episode
 * @property {() => number | undefined} dragT  a drag on the timeline: the time it would seek to
 * @property {() => void} draw  the player drawn again (on the next frame)
 * @property {() => void} animate  drawn every frame while it plays
 * @property {() => void} rebuild  the timeline's parts again (the audio's length is known)
 * @property {() => void} focusPlay  ▶ takes the keyboard
 */

/** Everything the player shows: the host's own, or as the host last said it. */
/** @typedef {{ t: number, playing: boolean, held: boolean, rate: number, muted: boolean, ready: boolean, loading: boolean, ended: boolean, dur: number, reach: number, err: string, note: boolean, until?: number, sent?: number }} Shown */

/** Second `t` kept on the timeline (`d` its length): never at the very end, where the audio would end. */
const onTimeline = (t, d) => Math.max(0, Math.min(d ? d - END_GUARD_S : t, t))
const num = (x) => (typeof x === 'number' ? x : undefined)
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** What a refused play() was: a pause before it started (nothing went wrong), one not started by a click or a key
 *  in this page (VS Code's webviews need one, once), or anything else. */
const refusal = (e) => (e && e.name === 'AbortError' ? 'abort' : e && e.name === 'NotAllowedError' ? 'gesture' : 'failed')
/** The error as the extension reads it (src/podcast/player.ts hostErrorKind): its name. */
const errorWord = (e) => String(e && (e.name || e.message))

/** A host starting an episode: from `at`, playing once loaded if `play`, one step if `until`; nothing wrong yet. */
function freshHostState(at, play, until) {
  return { startAt: at, wantPlay: !!play, until, resumeAt: undefined, endedSelf: false, held: false, errText: '', errNote: false }
}

/** A remote's copy of the host's state (`m`: what the host said, or what the player showed before). */
export function remoteStateFrom(m) {
  return {
    t: m.t || 0, playing: !!m.playing, held: !!m.held, rate: m.rate || 1, muted: !!m.muted, ready: !!m.ready,
    loading: !!m.loading, ended: !!m.ended, dur: m.dur || 0, reach: m.reach || 0, err: m.err || '', note: !!m.note,
    sent: Number(m.sent) || 0,
  }
}

/** The audio's host: the <audio>, loaded whole, and what it says to the extension. */
export class HostPlayer {
  /** @param {PlayerContext} ctx @param {HTMLAudioElement} audio */
  constructor(ctx, audio) {
    this.role = /** @type {const} */ ('host')
    this.ctx = ctx
    this.audio = audio
    /** @type {number} where to go once the audio can (before it is loaded) */
    this.startAt = 0
    /** @type {boolean} */ this.wantPlay = false
    /** @type {number | undefined} a stop where one step ends */ this.until = undefined
    /** @type {number | undefined} where the next ▶ starts (the walk is on a step the podcast skips) */ this.resumeAt = undefined
    /** @type {boolean} the episode ended by itself (not paused by the reader): a seek then plays on */ this.endedSelf = false
    /** @type {boolean} in the extension's own short wait: the audio stopped, the player shows it playing */ this.held = false
    /** @type {string} */ this.errText = ''
    /** @type {boolean} the error line is a note, not an error */ this.errNote = false
    /** The load under way (a newer one makes an older fetch's result stale), and the blob it made. */
    this.loadGen = 0
    this.loading = false
    /** @type {string | undefined} */ this.blobUrl = undefined
    this.blobbed = false
    /** @type {{ to: number, asked: boolean } | undefined} a seek under way (asked: by the extension) */
    this.seeking = undefined
    this.boundaryTimer = 0
    /** The second last said to the extension; where and when the clock last moved (frozenCheck). */
    this.saidSec = -1
    this.movedT = -1
    this.movedAt = 0
    /** Play was refused for want of a click or key here: ▶ takes the keyboard when the view gets it. */
    this.askFocus = false
    this.listeners = new AbortController()
    this.listen()
    // timeupdate stops when the clock does: the check runs on its own too.
    this.frozenTimer = window.setInterval(() => this.frozenCheck(), 1000)
  }

  // ---------- what the player shows ----------

  /** The audio's own length (0: not known yet). */
  audioDur() { const a = this.audio; return Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0 }
  /** The timeline's length: the episode's, or the audio's when it is longer. */
  total() { const ep = this.ctx.episode(); return Math.max((ep && ep.duration) || 0, this.audioDur()) || 0 }
  /** How far the audio goes: its own length (a cut file stops short of the episode). */
  reach() { return this.audioDur() || this.total() }
  playingNow() { return !this.audio.paused && !this.audio.ended }
  now() {
    const drag = this.ctx.dragT()
    if (drag !== undefined) return drag
    if (this.seeking) return this.seeking.to
    return this.audio.readyState < 1 ? this.startAt : this.audio.currentTime || 0
  }
  /** @returns {Shown} */
  state() {
    const a = this.audio
    return {
      t: this.now(), playing: this.playingNow() || (this.loading && this.wantPlay) || this.held, held: this.held,
      rate: a.playbackRate, muted: a.muted, ready: !this.loading && a.readyState >= 1, loading: this.loading,
      ended: this.endedSelf, dur: this.total(), reach: this.reach(), err: this.errText, note: this.errNote, until: this.until,
    }
  }

  // ---------- what it says to the extension ----------

  /** Says where the audio is: always what the audio itself reports (`t` only for a seek a blob is sure to make). */
  report(seek, t) {
    const ep = this.ctx.episode()
    if (!ep) return
    // Nothing to say before this episode's audio is there (an event of the one before it).
    if (t === undefined && (this.loading || this.audio.readyState < 1)) { this.postState(); return }
    const at = t !== undefined ? t : this.audio.currentTime || 0
    this.saidSec = Math.floor(at)
    this.ctx.post({ type: 'podcastTime', of: ep.key, t: at, playing: this.playingNow(), ...(this.held ? { held: true } : {}), rate: this.audio.playbackRate, sent: Date.now(), ...(seek ? { seek: true } : {}) })
    this.postState(seek, at)
    this.scheduleBoundary()
    this.mediaPosition()
  }
  /** What the remotes draw: everything the player shows. */
  postState(seek, t) {
    const ep = this.ctx.episode()
    if (!ep) return
    const s = this.state()
    this.ctx.post({ type: 'podcastState', of: ep.key, ...s, t: t !== undefined ? t : s.t, sent: Date.now(), ...(seek ? { seek: true } : {}) })
  }
  /** A line for the extension's log. */
  say(message) {
    const ep = this.ctx.episode()
    this.ctx.post({ type: 'podcastError', message, ...(ep ? { of: ep.key } : {}) })
  }
  /** Drawn: each second shown while playing is said too (one clock). */
  drawn(playing) {
    if (playing && this.ctx.dragT() === undefined && !this.seeking && Math.floor(this.audio.currentTime || 0) !== this.saidSec) this.report(false)
  }
  /** The system's "now playing" position (headphone keys, the media overlay). */
  mediaPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    const d = this.audioDur()
    if (!d) return
    try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: this.audio.playbackRate, position: Math.min(d, this.audio.currentTime || 0) }) } catch { /* a bad state: skipped */ }
  }

  /** Says where the audio is again right as the next segment starts, or stops where one step ends (`until`):
   *  timeupdate comes only every ~250 ms. */
  scheduleBoundary() {
    clearTimeout(this.boundaryTimer)
    const ep = this.ctx.episode()
    if (!ep || !this.playingNow()) return
    const t = this.audio.currentTime
    const nextSeg = ep.segments.find((s) => s.start > t + NEXT_SEGMENT_S)
    const at = Math.min(nextSeg ? nextSeg.start : Infinity, this.until !== undefined ? this.until : Infinity)
    if (!Number.isFinite(at)) return
    const ms = ((at - t) / (this.audio.playbackRate || 1)) * 1000 + BOUNDARY_LATE_MS
    this.boundaryTimer = window.setTimeout(() => { if (!this.untilCheck()) this.report(false) }, Math.max(BOUNDARY_LATE_MS, ms))
  }
  /** One step played (▶ on a storyline row): at its end the audio pauses. True when it did. */
  untilCheck() {
    if (this.until === undefined || !this.playingNow() || this.audio.currentTime < this.until - UNTIL_GUARD_S) return false
    this.until = undefined
    this.audio.pause()
    return true
  }

  // ---------- the controls ----------

  /**
   * To second `t`. `byExtension`: the extension asked (the walk is there already): a reader's seek also ends a hold
   * and a one-step play, and plays on after an end the audio reached by itself (the reader didn't pause it).
   */
  seek(t, byExtension = false) {
    if (!this.ctx.episode()) return
    const to = onTimeline(t, this.total())
    this.resumeAt = undefined
    if (this.errNote) this.showError('')
    const playOn = (this.endedSelf || this.held) && !byExtension
    this.endedSelf = false
    if (!byExtension) { this.held = false; this.until = undefined }
    if (this.audio.readyState < 1) {
      // Not loaded yet: it goes there once it is (loadedmetadata), and says so then.
      this.startAt = to
      this.ctx.draw()
      this.postState()
      return
    }
    const r = this.reach()
    this.seeking = { to: Math.min(to, r ? r - END_GUARD_S : to), asked: byExtension }
    this.audio.currentTime = this.seeking.to
    this.ctx.draw()
    // A blob always gets there: said at once, so the journey moves now, not once the audio has the place decoded.
    if (this.blobbed) this.report(true, this.seeking.to)
    if (playOn) this.play()
  }
  /** A seek done: where the audio is now is what counts. Somewhere else than asked (the source can't seek): logged,
   *  said in the player; the walk follows the audio, unless the walk moved first (then the audio pauses there). */
  seeked() {
    const s = this.seeking
    this.seeking = undefined
    const got = this.audio.currentTime || 0
    if (!s) { this.report(true); return }
    if (Math.abs(got - s.to) <= MISS_S) {
      if (!this.blobbed) this.report(true)
      return
    }
    this.say(`seek to ${clock(s.to)} ended at ${clock(got)}${this.blobbed ? '' : ' (the audio is streamed and its server ignores Range requests)'}`)
    this.showError(`Can't go to ${clock(s.to)} in this audio`)
    if (s.asked) { this.audio.pause(); this.report(false) } else this.report(true)
  }
  skip(by) { this.seek(this.now() + by) }
  part(dir) {
    const ep = this.ctx.episode()
    if (ep) this.seek(partStart(ep, this.now(), dir, this.total()))
  }
  /** Plays (from `at`; up to `upTo`, one step). Without `at`: where a skipped step left it, else from the start once
   *  the audio is at its end. */
  play(at, upTo) {
    if (!this.ctx.episode()) return
    this.held = false
    if (at !== undefined) this.seek(at, true)
    this.until = upTo
    // Still fetching: it plays once it is there.
    if (this.loading) { this.wantPlay = true; this.ctx.draw(); return }
    if (at === undefined && this.resumeAt !== undefined) this.seek(this.resumeAt)
    else if (at === undefined && (this.endedSelf || this.audio.ended || this.audio.currentTime >= this.reach() - REPLAY_GUARD_S)) this.seek(0)
    this.endedSelf = false
    if (this.errNote) this.showError('')
    this.movedT = -1
    const p = this.audio.play()
    if (p && p.catch) p.catch((e) => this.reportPlayFailure(e))
  }
  /** play() refused: never "playing" with the clock still. Without a click or a key here, no error is shown (the
   *  extension moves the audio where the reader is, the journey panel, its ▶ focused) and ▶ takes the keyboard when
   *  this view gets it. A pause before it started is nothing (the extension logs it at debug level). */
  reportPlayFailure(e) {
    const kind = refusal(e)
    if (kind === 'abort') { this.say('AbortError'); return }
    if (!this.audio.paused) this.audio.pause()
    if (kind === 'gesture') this.askFocus = true
    else this.showError(`Can't play: ${e && e.message}`)
    this.say(errorWord(e))
    this.ctx.draw()
    this.report(false)
  }
  pause() {
    this.wantPlay = false
    this.until = undefined
    this.endedSelf = false
    // Paused in a hold: the audio stood still already (no pause event), so it is said here.
    const wasHeld = this.held
    this.held = false
    this.audio.pause()
    this.ctx.draw()
    if (wasHeld) this.report(false)
    else this.postState()
  }
  /** The extension's short wait (the code moving): the audio stops, the player shows it playing. */
  hold() {
    if (!this.playingNow() && !(this.loading && this.wantPlay)) return
    this.held = true
    this.wantPlay = false
    this.audio.pause()
    this.ctx.draw()
    this.report(false)
  }
  /** The wait over: plays on (one step played still stops at its end). Nothing if the reader paused, sought or
   *  played meanwhile (the hold is gone then). */
  unhold() {
    if (!this.held) return
    this.held = false
    const p = this.audio.play()
    if (p && p.catch) p.catch((e) => { if (refusal(e) !== 'abort') { this.say(errorWord(e)); this.ctx.draw(); this.report(false) } })
    this.ctx.draw()
  }
  toggle() { if (this.state().playing) this.pause(); else this.play() }
  setRate(r) {
    this.audio.playbackRate = r
    this.audio.defaultPlaybackRate = r
  }
  setMuted(m) {
    this.audio.muted = m
    this.ctx.draw()
    this.report(false)
  }
  showError(text, isNote = false) {
    this.errText = text
    this.errNote = !!text && !!isNote
    this.ctx.draw()
    this.postState()
  }

  /** The extension's command (src/protocol/podcast.ts ToPlayer podcastCmd). @param {PodcastCommand} m */
  command(m) {
    switch (m.action) {
      case 'play': this.play(num(m.at), num(m.until)); break
      case 'toggle': this.toggle(); break
      case 'pause':
        if (m.hold) { this.hold(); break }
        this.pause()
        // With a note: the walk is on a step the podcast skips; ▶ goes on from `resumeAt`.
        if (m.note) this.showError(String(m.note), true)
        if (typeof m.resumeAt === 'number') this.resumeAt = m.resumeAt
        break
      case 'unhold': this.unhold(); break
      // A quiet line in the player (the camera waiting before the code moves); '' clears it.
      case 'note': this.showError(String(m.text || ''), true); break
      case 'skip': this.skip(Number(m.by) || 0); break
      case 'seek': this.seek(Number(m.to) || 0, !m.reader); break
      case 'part': this.part((m.dir ?? 0) < 0 ? -1 : 1); break
      case 'rate': this.setRate(knownRate(Number(m.rate))); break
      case 'mute': this.setMuted(typeof m.muted === 'boolean' ? m.muted : !this.audio.muted); break
      case 'focus': this.ctx.focusPlay(); break
      default: this.say(`unknown command ${m.action}`)
    }
  }

  // ---------- the episode ----------

  /** Episode `ep` from `cue` (where, playing or not, one step, its speed and muting): loaded, nothing kept from the
   *  episode before. */
  start(ep, cue) {
    Object.assign(this, freshHostState(cue.at, cue.play, cue.until))
    this.setRate(knownRate(cue.rate))
    this.audio.muted = !!cue.muted
    this.load(ep)
  }
  /** Another episode comes: where the one leaving was is said first (kept for next time). */
  leave() {
    if (!this.ctx.episode()) return
    this.held = false
    this.audio.pause()
    this.report(false)
  }

  /** The audio of episode `e`, loaded whole as a blob (seekable wherever it is served from); else its own URL. The
   *  audio is fetched whole because a server that ignores HTTP Range (VS Code for the web, remote windows) serves
   *  media Chromium can't seek in; then a seek lands at 0:00. */
  load(e) {
    const gen = ++this.loadGen
    this.dropBlob()
    this.blobbed = false
    this.seeking = undefined
    this.loading = true
    this.audio.removeAttribute('src')
    this.audio.load()
    const use = (src, isBlob) => {
      this.loading = false
      this.blobbed = isBlob
      this.audio.src = src
      this.audio.load()
      if (this.wantPlay) { this.wantPlay = false; this.play(undefined, this.until) }
    }
    fetch(e.src).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.blob()
    }).then((b) => {
      if (gen !== this.loadGen) return
      this.blobUrl = URL.createObjectURL(b)
      use(this.blobUrl, true)
    }).catch((x) => {
      if (gen !== this.loadGen) return
      this.say(`the audio could not be loaded whole (${x && x.message}); it is streamed, and seeking may not work where its server ignores Range requests`)
      use(e.src, false)
    })
  }
  /** No episode (none, or unavailable): the audio unloaded, where it was said first. */
  unload() {
    if (!this.ctx.episode()) return
    this.report(false)
    this.loadGen++
    this.loading = false
    this.wantPlay = false
    this.seeking = undefined
    this.until = undefined
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.dropBlob()
  }
  dropBlob() {
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = undefined }
  }

  /** Playing with the clock still for FROZEN_MS (a cut or broken file): paused, and said. */
  frozenCheck() {
    if (!this.playingNow() || this.seeking) { this.movedT = -1; return }
    const t = this.audio.currentTime
    if (t !== this.movedT) { this.movedT = t; this.movedAt = Date.now(); return }
    if (Date.now() - this.movedAt < FROZEN_MS) return
    this.audio.pause()
    this.showError(`The audio doesn't play on from ${clock(t)}`)
    this.say(`the audio stopped at ${clock(t)} while playing (readyState ${this.audio.readyState}, networkState ${this.audio.networkState})`)
  }

  /** The audio's events, while this is the host. */
  listen() {
    const a = this.audio
    const o = { signal: this.listeners.signal }
    a.addEventListener('loadedmetadata', () => {
      const ep = this.ctx.episode()
      if (ep && Number.isFinite(a.duration)) this.ctx.post({ type: 'podcastMeta', of: ep.key, duration: a.duration })
      const to = Math.min(this.startAt, Math.max(0, this.reach() - END_GUARD_S))
      this.startAt = 0
      this.ctx.rebuild()
      if (to > 0) {
        this.seeking = { to, asked: false }
        a.currentTime = to
        if (this.blobbed) this.report(true, to)
      } else this.report(true) // Where it starts, said once it is there (the walk, when it follows this podcast, goes there).
      this.ctx.draw()
    }, o)
    a.addEventListener('seeked', () => { this.seeked(); this.ctx.draw() }, o)
    a.addEventListener('timeupdate', () => {
      if (this.untilCheck()) return
      if (this.ctx.dragT() === undefined) this.ctx.draw()
      if (!this.seeking) this.report(false)
      this.frozenCheck()
    }, o)
    a.addEventListener('play', () => {
      this.askFocus = false
      this.endedSelf = false
      if (!this.errNote) this.showError('')
      this.movedT = -1
      this.ctx.draw()
      this.ctx.animate()
      this.report(false)
    }, o)
    a.addEventListener('pause', () => { this.ctx.draw(); this.report(false) }, o)
    a.addEventListener('ended', () => { this.endedSelf = true; this.held = false; this.until = undefined; this.ctx.draw(); this.report(false) }, o)
    a.addEventListener('ratechange', () => { this.ctx.draw(); this.report(false) }, o)
    a.addEventListener('volumechange', () => { this.ctx.draw(); this.postState() }, o)
    a.addEventListener('error', () => {
      if (!a.getAttribute('src')) return // emptied on purpose (another episode, none)
      const e = a.error
      this.seeking = undefined
      // Not playing: never "playing" with the clock still.
      if (!a.paused) a.pause()
      this.say(`audio error ${e ? e.code : '?'}${e && e.message ? `: ${e.message}` : ''}`)
      this.showError("Can't play the audio")
      this.report(false)
    }, o)
    window.addEventListener('focus', () => { if (this.askFocus) this.ctx.focusPlay() }, o)
  }

  /** No longer the host (a remote now, or the player gone): the audio unloaded, its events and timers stopped. */
  dispose() {
    this.unload()
    this.listeners.abort()
    clearInterval(this.frozenTimer)
    clearTimeout(this.boundaryTimer)
  }
}

/** A remote: no sound; it draws the host's state (relayed by the extension) and asks the host to act. */
export class RemotePlayer {
  /** @param {PlayerContext} ctx @param {Partial<PodcastHostState>} shown what to show until the host says more */
  constructor(ctx, shown = {}) {
    this.role = /** @type {const} */ ('remote')
    this.ctx = ctx
    this.R = remoteStateFrom(shown)
    /** When the host's state came (performance.now()). */
    this.rAt = performance.now()
    /** @type {{ t: number, at: number } | undefined} a seek asked meanwhile */
    this.asked = undefined
    /** What was just asked (play, pause, speed, muting) shows at once; the host's reports from before it don't undo
     *  it. @type {Record<string, { v: unknown, at: number }>} */
    this.pend = {}
    // With reduced motion there are no frames: the clock still moves, once a second.
    this.clockTimer = window.setInterval(() => { if (this.R.playing && reduced()) this.ctx.draw() }, 1000)
  }

  total() { const ep = this.ctx.episode(); return Math.max((ep && ep.duration) || 0, this.R.dur || 0) || 0 }
  reach() { return this.R.reach || this.total() }
  now() {
    const drag = this.ctx.dragT()
    if (drag !== undefined) return drag
    if (this.asked) return this.asked.t
    // From when the host said it (its own clock: the same machine's), not when the relay brought it: a slow relay
    // never puts this player behind the audio. In a hold the audio stands still.
    const R = this.R
    const since = R.sent ? Math.max(0, Date.now() - R.sent) : performance.now() - this.rAt
    const t = R.playing && !R.held ? R.t + (since / 1000) * (R.rate || 1) : R.t
    return Math.min(t, this.reach() || t)
  }
  /** @returns {Shown} */
  state() { return { ...this.R, t: this.now(), dur: this.total(), reach: this.reach() } }

  /** An action for the host. */
  ask(action, more = {}) {
    const ep = this.ctx.episode()
    if (ep) this.ctx.post({ type: 'podcastAsk', of: ep.key, action, ...more })
  }
  /** `k` shown as `v` at once, until the host says so too or ASK_STALE_MS pass. */
  pending(k, v) { this.pend[k] = { v, at: performance.now() } }

  seek(t) {
    if (!this.ctx.episode()) return
    const to = onTimeline(t, this.total())
    this.ask('seek', { to })
    this.asked = { t: to, at: performance.now() }
    this.ctx.draw()
  }
  skip(by) { this.ask('skip', { by }) }
  part(dir) { this.ask('part', { dir }) }
  play(at, upTo) {
    if (!this.ctx.episode()) return
    this.ask('play', { ...(at !== undefined ? { at } : {}), ...(upTo !== undefined ? { until: upTo } : {}) })
    this.R.playing = true
    this.pending('playing', true)
    this.rAt = performance.now()
    this.ctx.draw()
  }
  pause() {
    if (!this.ctx.episode()) return
    this.ask('pause')
    this.R.t = this.now()
    this.R.playing = false
    this.pending('playing', false)
    this.rAt = performance.now()
    this.ctx.draw()
  }
  toggle() { if (this.state().playing) this.pause(); else this.play() }
  setRate(r) {
    this.ask('rate', { rate: r })
    this.R.rate = r
    this.pending('rate', r)
    this.ctx.draw()
  }
  setMuted(m) {
    this.ask('mute', { muted: m })
    this.R.muted = m
    this.pending('muted', m)
    this.ctx.draw()
  }

  /** Another episode: shown from its start place until the host says where it is (the cue is the host's). */
  start(ep, _cue) {
    this.R = remoteStateFrom({ t: ep.at || 0, rate: ep.rate || 1, muted: !!ep.muted })
    this.rAt = performance.now()
    this.asked = undefined
  }
  leave() { /* nothing plays here */ }

  /** The host's state (podcastState). @param {PodcastHostState} m */
  hostState(m) {
    const ep = this.ctx.episode()
    if (!ep || m.of !== ep.key) return
    // A report from before the seek just asked for: the time asked stays until the host says it moved.
    if (this.asked && !m.seek && performance.now() - this.asked.at < ASK_STALE_MS) return
    this.asked = undefined
    const R = remoteStateFrom(m)
    for (const k of Object.keys(this.pend)) {
      if (R[k] === this.pend[k].v || performance.now() - this.pend[k].at > ASK_STALE_MS) delete this.pend[k]
      else R[k] = this.pend[k].v
    }
    this.R = R
    this.rAt = performance.now()
    this.ctx.draw()
    this.ctx.animate()
  }

  dispose() { clearInterval(this.clockTimer) }
}
