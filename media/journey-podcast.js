// The journey's listening player: the caption, a timeline marked by step, and the controls. Two of them are made:
//
// - The audio's host (mode 'host', the Listen view: media/listen.js). The <audio> lives here, in a view VS Code keeps
//   alive while hidden (retainContextWhenHidden), so the episode goes on when the journey panel is closed, behind
//   another tab, or VS Code has no focus. Where the journey should be at a time is the extension's to work out
//   (src/podcast/): this player only plays, seeks and says where the audio is.
// - A remote (mode 'remote', the journey panel: journey-map.js). Same look, no audio: it draws the state the host
//   reports (relayed by the extension as podcastState) and asks the host, through the extension, to play, seek …
//   (podcastAsk). The panel can close and open again: the audio does not notice.
//
// Needs common.js. JourneyPodcast({ post, mode, stepTitle(n), stepCount(), keyPrefix(), onShown(h), onListening(on),
// onTick(t), onEnd(action), mount? }) — `mount`: where the player goes (default: fixed at the window's bottom).
//
// The audio is loaded whole (fetch, then a blob: URL) before it plays: a server that ignores HTTP Range (VS Code for
// the web, and remote windows) serves media Chromium can't seek in, and a seek there lands at 0:00. If the fetch
// fails, the file's own URL plays, and where a seek lands is what the audio says once it is done, never the time asked.
//
// In:
//   { type: 'podcast', episode? }  the episode ({ key, src, title, journey, duration, at, play?, rate, muted, chapters,
//                                  segments, steps, notice?, next? }), or { unavailable: why } (one line saying so), or
//                                  none (the player goes). Host: `at` where it starts, `play` plays once loaded.
//   { type: 'podcastCmd', action, … }   (host) play { at?, until? } | pause { note?, resumeAt?, hold? } | unhold |
//                                  note { text } | toggle | skip { by } | seek { to } | part { dir } | rate { rate } |
//                                  mute { muted? }
//                                  A pause with `hold` is the extension's own short wait (the code moving: camera.ts):
//                                  the audio stops, but the player keeps showing it as playing; `unhold` plays on
//                                  (nothing if the reader paused, sought or played meanwhile).
//   { type: 'podcastState', … }    (remote) the host's state: { of, t, playing, held?, rate, muted, ready, loading,
//                                  ended, dur, reach, err, note, until, seek?, sent }
// Out:
//   host:   { type: 'podcastTime', of, t, playing, held?, rate, seek?, sent }  where the audio is (seek: moved by a
//                                  seek; playing: the audio itself; held: in a hold; sent: Date.now() when said); said
//                                  each time the shown second changes too
//           { type: 'podcastState', of, … }  everything the player shows (for the remotes), on every change
//           { type: 'podcastError', of, message }  { type: 'podcastMeta', of, duration }
//   remote: { type: 'podcastAsk', of, action, … }  the actions above, for the host
//   both:   { type: 'podcastWhy' }  "Show why";  { type: 'podcastEnd', action: 'walk' | 'next' } (the end's buttons)
;(function () {
  const { el, svgEl, runKey } = window.common

  /** Back / forward (s): the keys (← →) and the commands; no buttons (the units of a walk are steps). */
  const SKIP_S = 15
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
  /** A seek that lands further than this from where it was asked to go (s) did not get there. */
  const MISS_S = 0.75
  /** Playing, the clock not moving for this long (ms): it is not playing (a broken or cut file); it pauses and says so. */
  const FROZEN_MS = 3000
  /** A step's mark on the timeline is at least this wide (px): a target a pointer can hit. */
  const MARK_MIN_PX = 8
  /** A mark shows its number when it is this wide (px). */
  const MARK_NUM_PX = 13
  /** Remote: after asking for a seek, the host's reports of the time before it are ignored this long (ms). */
  const ASK_STALE_MS = 700
  /** The audio is shorter than the episode by more than this (s): the rest of the timeline can't be reached. */
  const CUT_S = 1

  const PATHS = {
    play: 'M5 3.5v13l11-6.5z',
    pause: 'M5 3h3.5v14H5zM11.5 3H15v14h-3.5z',
    prev: 'M4 3h2v14H4zM16 3v14L7 10z',
    next: 'M14 3h2v14h-2zM4 3v14l9-7z',
    vol: 'M3 7.5h3l4.5-4v13l-4.5-4H3zM13 6.5a5 5 0 0 1 0 7M14.8 4.3a8 8 0 0 1 0 11.4',
    muted: 'M3 7.5h3l4.5-4v13l-4.5-4H3zM13 7.5l5 5M18 7.5l-5 5',
  }
  function icon(name) {
    const s = svgEl('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true' })
    const stroke = name === 'vol' || name === 'muted'
    s.append(svgEl('path', stroke ? { d: PATHS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } : { d: PATHS[name], fill: 'currentColor' }))
    return s
  }
  function clock(t) {
    const s = Math.max(0, Math.floor(t || 0))
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
    return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`
  }
  /** "11 minutes 59 seconds": a time as a screen reader should say it. */
  function spoken(t) {
    const s = Math.max(0, Math.floor(t || 0))
    const m = Math.floor(s / 60), r = s % 60
    const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
    return m ? `${unit(m, 'minute')}${r ? ` ${unit(r, 'second')}` : ''}` : unit(r, 'second')
  }
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const rateText = (r) => `${r}×`
  const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

  /** A segment's sentences with their times: the file's (`sentences`, checked by the extension), else estimated by
   *  each sentence's share of the segment's characters. */
  function sentencesOf(seg) {
    const end = Math.max(seg.end, seg.start)
    if (Array.isArray(seg.sentences) && seg.sentences.length) {
      return seg.sentences.map((x, i, a) => ({ start: x.start, end: i + 1 < a.length ? a[i + 1].start : end, text: x.text }))
    }
    const text = seg.text || ''
    const clock = charClock(seg, end)
    const out = []
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g
    let m
    while ((m = re.exec(text)) && m[0]) {
      const lead = m[0].length - m[0].trimStart().length
      const t = m[0].trim()
      if (!t) continue
      const off = m.index + lead
      out.push({ start: clock(off), end: clock(off + t.length), text: t, clock, off })
    }
    return out
  }
  /**
   * When character `i` of segment `seg`'s text is said (s): the marks' phrases are said at their times (word-timed by
   * the script), so they anchor it; in between, and with no marks, the time is shared by the characters.
   */
  function charClock(seg, end) {
    const text = seg.text || ''
    const pts = [[0, seg.start]]
    let from = 0
    for (const mk of Array.isArray(seg.marks) ? seg.marks : []) {
      if (!mk || typeof mk.phrase !== 'string' || !mk.phrase || typeof mk.at !== 'number') continue
      const i = text.indexOf(mk.phrase, from)
      const t = seg.start + mk.at
      const [pi, pt] = pts[pts.length - 1]
      if (i < 0 || i <= pi || t <= pt || t >= end) continue
      pts.push([i, t])
      from = i + mk.phrase.length
    }
    pts.push([Math.max(text.length, pts[pts.length - 1][0] + 1), end])
    return (c) => {
      let k = 1
      while (k < pts.length - 1 && pts[k][0] < c) k++
      const [a, ta] = pts[k - 1], [b, tb] = pts[k]
      return ta + ((tb - ta) * Math.max(0, Math.min(b - a, c - a))) / (b - a)
    }
  }

  window.JourneyPodcast = function (opts) {
    const { post } = opts
    const host = opts.mode !== 'remote'
    const audio = host ? el('audio') : undefined
    if (audio) audio.preload = 'metadata'
    const root = el('div', `pod${opts.mount ? ' inline' : ''}`)
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', 'Listen')
    root.hidden = true

    // What is wrong with the podcast (or that it can't be played), and the way to the details.
    const note = el('div', 'pod-note')
    note.hidden = true
    const noteText = el('span', 'pod-note-t')
    const whyB = el('button', 'link pod-why', 'Show why')
    whyB.onclick = () => post({ type: 'podcastWhy' })
    note.append(noteText, whyB)

    // The caption: the sentence being said, two lines at most (a long one in parts), the speaker when the voice changes.
    const cap = el('div', 'pod-cap')
    const capText = el('div', 'pod-cap-t')
    cap.append(capText)
    const capMeasure = el('div', 'pod-cap-t pod-cap-m')
    capMeasure.setAttribute('aria-hidden', 'true')
    cap.append(capMeasure)
    // The end: what next.
    const endBox = el('div', 'pod-end')
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
    tip.hidden = true
    tl.append(track, reachEl, ghost, thumb, marks, tip)

    const btn = (cls, label, child, onClick) => {
      const b = el('button', `pod-b ${cls}`)
      b.title = label
      b.setAttribute('aria-label', label.replace(/ \(.*\)$/, ''))
      b.append(child)
      b.onclick = onClick
      return b
    }
    const prevB = btn('prev', 'Previous step (Shift+←)', icon('prev'), () => part(-1))
    const playB = btn('play', 'Play', icon('play'), () => toggle())
    const nextB = btn('next', 'Next step (Shift+→)', icon('next'), () => part(1))
    const time = el('span', 'pod-time')
    const timeNow = el('span', 'pod-now')
    const timeTotal = el('span', 'pod-total')
    time.append(timeNow, timeTotal)
    const where = el('span', 'pod-where')
    const rateB = el('button', 'pod-rate', '1×')
    rateB.setAttribute('aria-haspopup', 'menu')
    rateB.onclick = () => (menu.hidden ? openMenu() : closeMenu())
    const muteB = btn('mute pod-mute', 'Mute (M)', icon('vol'), () => setMuted(!S().muted))
    // An error, or a note ("not in the podcast"): one short line under the controls.
    const err = el('div', 'pod-err')
    err.hidden = true
    err.setAttribute('role', 'status')
    const row = el('div', 'pod-row')
    const ctl = el('div', 'pod-ctl')
    ctl.append(prevB, playB, nextB)
    const opt = el('div', 'pod-opt')
    opt.append(rateB, muteB)
    row.append(ctl, time, where, opt)
    // The speed menu (fixed: never cut by the player's edges).
    const menu = el('div', 'pod-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Playback speed')
    menu.hidden = true
    // Said once per step change (a screen reader's polite announcement), never per frame.
    const live = el('div', 'pod-sr')
    live.setAttribute('aria-live', 'polite')
    root.append(note, cap, endBox, tl, row, err, menu, live)
    if (audio) root.append(audio)
    ;(opts.mount || document.body).append(root)

    /** The episode shown ({ key, duration, chapters: [{ start, end, step }], segments: [{ start, end, text, step,
     *  speaker, sentences? }], steps: [{ n, title }] }). */
    let ep
    /** The step marks ({ el, c, i }) and the bars ({ el, fill, c }). */
    let bars = []
    let markEls = []
    /** A drag on the timeline: the time it would seek to (undefined: none). */
    let dragT
    let frame = 0
    let drawnSec = -1
    let saidWhere = ''

    // ---------- the state: the audio's own (host), or as the host last said it (remote) ----------

    /** Host: the time to seek to once the audio can; the blob; the load under way; a seek under way; where the next ▶
     *  starts (a step the podcast skips); a stop at `until` (one step played); the error or note shown. */
    let startAt = 0
    let blobUrl
    let loadGen = 0
    let loading = false
    let wantPlay = false
    let blobbed = false
    let seeking
    let resumeAt
    let until
    let errText = ''
    let errNote = false
    /** The episode ended by itself (not paused by the reader): a seek then plays on (F96). */
    let endedSelf = false
    /** In a hold (the extension's own short wait): the audio stopped, the player still shows it playing. */
    let held = false
    let boundaryTimer = 0
    let saidSec = -1
    let movedT = -1
    let movedAt = 0
    /** Play was refused for want of a click or key here: ▶ takes the keyboard when the view gets it. */
    let askFocus = false
    if (host) window.addEventListener('focus', () => { if (askFocus) playB.focus({ preventScroll: true }) })

    /** Remote: the host's last state, when it came (performance.now()), and a seek asked meanwhile. */
    let R = { t: 0, playing: false, held: false, rate: 1, muted: false, ready: false, loading: false, ended: false, dur: 0, reach: 0, err: '', note: false, sent: 0 }
    let rAt = 0
    let asked
    /** Remote: what was just asked (speed, muting) shows at once; the host's reports from before it don't undo it. */
    let pend = {}
    const pending = (k, v) => { pend[k] = { v, at: performance.now() } }

    const epDur = () => (ep && ep.duration) || 0
    /** The audio's own length (0: not known yet). */
    const audioDur = () => (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0)
    /** The timeline's length: the episode's, or the audio's when it is longer. */
    const total = () => (host ? Math.max(epDur(), audioDur()) : Math.max(epDur(), R.dur || 0)) || 0
    /** How far the audio goes: its own length (a cut file stops short of the episode). */
    const reach = () => (host ? audioDur() || total() : R.reach || total())
    const hostPlaying = () => !!audio && !audio.paused && !audio.ended
    function hostNow() {
      if (dragT !== undefined) return dragT
      if (seeking) return seeking.to
      return audio.readyState < 1 ? startAt : audio.currentTime || 0
    }
    function remoteNow() {
      if (dragT !== undefined) return dragT
      if (asked) return asked.t
      // From when the host said it (its own clock: the same machine's), not when the relay brought it: a slow relay
      // never puts this player behind the audio. In a hold the audio stands still.
      const since = R.sent ? Math.max(0, Date.now() - R.sent) : performance.now() - rAt
      const t = R.playing && !R.held ? R.t + (since / 1000) * (R.rate || 1) : R.t
      return Math.min(t, reach() || t)
    }
    /** Everything the player shows. */
    function S() {
      if (host) {
        return {
          t: hostNow(), playing: hostPlaying() || (loading && wantPlay) || held, held, rate: audio.playbackRate, muted: audio.muted,
          ready: !loading && audio.readyState >= 1, loading, ended: endedSelf, dur: total(), reach: reach(), err: errText,
          note: errNote, until,
        }
      }
      return { ...R, t: remoteNow(), dur: total(), reach: reach() }
    }

    const chapterAt = (t) => {
      if (!ep) return -1
      const cs = ep.chapters
      for (let i = cs.length - 1; i >= 0; i--) if (t >= cs[i].start) return i
      return 0
    }
    const segAt = (t) => {
      if (!ep || !ep.segments.length) return -1
      const ss = ep.segments
      for (let i = ss.length - 1; i >= 0; i--) if (t >= ss[i].start) return i
      return 0
    }
    const stepTitle = (n) => (ep && ep.steps && ep.steps[n - 1] ? ep.steps[n - 1].title : opts.stepTitle ? opts.stepTitle(n) : '') || ''
    const stepCount = () => (ep && ep.steps ? ep.steps.length : opts.stepCount ? opts.stepCount() : 0)
    /** A part on the map (no step): the first is the intro, the last the recap. */
    function mapName(i) {
      if (i === 0) return 'Intro'
      return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
    }
    /** "Step 6 of 14 · title", or Intro / Map / Recap. */
    function partName(i, short) {
      const c = ep.chapters[i]
      if (!c) return ''
      if (!c.step) return mapName(i)
      const t = stepTitle(c.step)
      return `${short ? `Step ${c.step}` : `Step ${c.step} of ${stepCount() || '?'}`}${t ? ` · ${t}` : ''}`
    }
    const keyPrefix = () => (opts.keyPrefix && opts.keyPrefix()) || "Ctrl+'"

    // ---------- host: the audio ----------

    /** Says where the audio is: always what the audio itself reports (`t` only for a seek a blob is sure to make). */
    function report(seek, t) {
      if (!host || !ep) return
      // Nothing to say before this episode's audio is there (an event of the one before it).
      if (t === undefined && (loading || audio.readyState < 1)) { postState(); return }
      const at = t !== undefined ? t : audio.currentTime || 0
      saidSec = Math.floor(at)
      post({ type: 'podcastTime', of: ep.key, t: at, playing: hostPlaying(), ...(held ? { held: true } : {}), rate: audio.playbackRate, sent: Date.now(), ...(seek ? { seek: true } : {}) })
      postState(seek, at)
      scheduleBoundary()
      mediaPosition()
    }
    /** What the remotes draw: everything the player shows. */
    function postState(seek, t) {
      if (!host || !ep) return
      const s = S()
      post({ type: 'podcastState', of: ep.key, ...s, t: t !== undefined ? t : s.t, sent: Date.now(), ...(seek ? { seek: true } : {}) })
    }
    /** A line for the extension's log. */
    const say = (message) => post({ type: 'podcastError', message, ...(ep ? { of: ep.key } : {}) })
    /** Says where the audio is again right as the next segment starts, or stops where one step ends (`until`):
     *  timeupdate comes only every ~250 ms. */
    function scheduleBoundary() {
      clearTimeout(boundaryTimer)
      if (!host || !ep || !hostPlaying()) return
      const t = audio.currentTime
      const nextSeg = ep.segments.find((s) => s.start > t + 0.01)
      const at = Math.min(nextSeg ? nextSeg.start : Infinity, until !== undefined ? until : Infinity)
      if (!Number.isFinite(at)) return
      const ms = ((at - t) / (audio.playbackRate || 1)) * 1000 + 20
      boundaryTimer = setTimeout(() => { if (!untilCheck()) report(false) }, Math.max(20, ms))
    }
    /** One step played (▶ on a storyline row): at its end the audio pauses. True when it did. */
    function untilCheck() {
      if (until === undefined || !hostPlaying() || audio.currentTime < until - 0.06) return false
      until = undefined
      audio.pause()
      return true
    }

    /** To second `t`. `asked`: the extension asked (the walk is there already). */
    function seek(t, byExtension) {
      if (!ep) return
      const d = total()
      const to = Math.max(0, Math.min(d ? d - 0.05 : t, t))
      if (!host) { ask('seek', { to }); asked = { t: to, at: performance.now() }; draw(); return }
      resumeAt = undefined
      if (errNote) showError('')
      // A seek after the episode ended by itself plays on from there (the reader didn't pause it); so does the reader's
      // seek in a hold (it looked like playing).
      const playOn = (endedSelf || held) && !byExtension
      endedSelf = false
      if (!byExtension) held = false
      if (!byExtension) until = undefined
      if (audio.readyState < 1) {
        // Not loaded yet: it goes there once it is (loadedmetadata), and says so then.
        startAt = to
        draw()
        postState()
        return
      }
      const r = reach()
      seeking = { to: Math.min(to, r ? r - 0.05 : to), asked: !!byExtension }
      audio.currentTime = seeking.to
      draw()
      // A blob always gets there: said at once, so the journey moves now, not once the audio has the place decoded.
      if (blobbed) report(true, seeking.to)
      if (playOn) play()
    }
    /** A seek done: where the audio is now is what counts. Somewhere else than asked (the source can't seek): logged,
     *  said in the player; the walk follows the audio, unless the walk moved first (then the audio pauses there). */
    function seeked() {
      const s = seeking
      seeking = undefined
      const got = audio.currentTime || 0
      if (!s) { report(true); return }
      if (Math.abs(got - s.to) <= MISS_S) {
        if (!blobbed) report(true)
        return
      }
      say(`seek to ${clock(s.to)} ended at ${clock(got)}${blobbed ? '' : ' (the audio is streamed and its server ignores Range requests)'}`)
      showError(`Can't go to ${clock(s.to)} in this audio`)
      if (s.asked) { audio.pause(); report(false) }
      else report(true)
    }
    const skip = (by) => (host ? seek(hostNow() + by) : ask('skip', { by }))
    function part(dir) {
      if (!ep) return
      if (!host) { ask('part', { dir }); return }
      const t = hostNow()
      const cs = ep.chapters
      const i = chapterAt(t)
      if (dir > 0) seek(i + 1 < cs.length ? cs[i + 1].start : total())
      // ⏮ is always the part before, as the step card's ‹ Previous (src/podcast/model.ts chapterJump).
      else seek(i === 0 ? cs[0].start : cs[i - 1].start)
    }
    function play(at, upTo) {
      if (!ep) return
      if (!host) { ask('play', { ...(at !== undefined ? { at } : {}), ...(upTo !== undefined ? { until: upTo } : {}) }); R.playing = true; rAt = performance.now(); draw(); return }
      held = false
      if (at !== undefined) seek(at, true)
      until = upTo
      // Still fetching: it plays once it is there.
      if (loading) { wantPlay = true; draw(); return }
      if (at === undefined && resumeAt !== undefined) seek(resumeAt)
      else if (at === undefined && (endedSelf || audio.ended || audio.currentTime >= reach() - 0.1)) seek(0)
      endedSelf = false
      if (errNote) showError('')
      movedT = -1
      const p = audio.play()
      if (p && p.catch) p.catch((e) => {
        // A pause before it started (a quick Space, Space): nothing went wrong (the extension logs it at debug level).
        if (e && e.name === 'AbortError') { say('AbortError'); return }
        // VS Code's webviews play audio only after a click or a key in them (once per view): ▶ takes the keyboard.
        const gesture = e && e.name === 'NotAllowedError'
        // Not playing: never "playing" with the clock still.
        if (!audio.paused) audio.pause()
        showError(gesture ? 'Press Space to play' : `Can't play: ${e && e.message}`)
        if (gesture) { askFocus = true; playB.focus({ preventScroll: true }) }
        say(String(e && (e.name || e.message)))
        draw()
        report(false)
      })
    }
    function pause() {
      if (!host) { ask('pause'); R.playing = false; R.t = remoteNow(); rAt = performance.now(); draw(); return }
      wantPlay = false
      until = undefined
      endedSelf = false
      // Paused in a hold: the audio stood still already (no pause event), so it is said here.
      const wasHeld = held
      held = false
      audio.pause()
      draw()
      if (wasHeld) report(false)
      else postState()
    }
    /** The extension's short wait (the code moving): the audio stops, the player shows it playing. */
    function hold() {
      if (!hostPlaying() && !(loading && wantPlay)) return
      held = true
      wantPlay = false
      audio.pause()
      draw()
      report(false)
    }
    /** The wait over: plays on (one step played still stops at its end). Nothing if the reader paused, sought or
     *  played meanwhile (the hold is gone then). */
    function unhold() {
      if (!held) return
      held = false
      const p = audio.play()
      if (p && p.catch) p.catch((e) => { if (!(e && e.name === 'AbortError')) { say(String(e && (e.name || e.message))); draw(); report(false) } })
      draw()
    }
    const toggle = () => (S().playing ? pause() : play())
    function setRate(r) {
      if (!host) { ask('rate', { rate: r }); R.rate = r; pending('rate', r); draw(); return }
      audio.playbackRate = r
      audio.defaultPlaybackRate = r
    }
    function setMuted(m) {
      if (!host) { ask('mute', { muted: m }); R.muted = m; pending('muted', m); draw(); return }
      audio.muted = m
      draw()
      report(false)
    }
    function showError(text, isNote) {
      errText = text
      errNote = !!text && !!isNote
      draw()
      postState()
    }
    /** Remote: an action for the host. */
    function ask(action, more) {
      if (!ep) return
      post({ type: 'podcastAsk', of: ep.key, action, ...(more || {}) })
    }

    /** The audio of episode `e`, loaded whole as a blob (seekable wherever it is served from); else its own URL. */
    function load(e) {
      const gen = ++loadGen
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined }
      blobbed = false
      seeking = undefined
      loading = true
      audio.removeAttribute('src')
      audio.load()
      const use = (src, isBlob) => {
        loading = false
        blobbed = isBlob
        audio.src = src
        audio.load()
        if (wantPlay) { wantPlay = false; play(undefined, until) }
      }
      fetch(e.src).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.blob()
      }).then((b) => {
        if (gen !== loadGen) return
        blobUrl = URL.createObjectURL(b)
        use(blobUrl, true)
      }).catch((x) => {
        if (gen !== loadGen) return
        say(`the audio could not be loaded whole (${x && x.message}); it is streamed, and seeking may not work where its server ignores Range requests`)
        use(e.src, false)
      })
    }

    // ---------- the speed menu ----------

    function openMenu() {
      menu.textContent = ''
      const cur = S().rate
      for (const r of RATES) {
        const it = el('button', `pod-mi${r === cur ? ' on' : ''}`, rateText(r))
        it.setAttribute('role', 'menuitemradio')
        it.setAttribute('aria-checked', String(r === cur))
        it.onclick = () => { setRate(r); closeMenu(true) }
        menu.append(it)
      }
      menu.hidden = false
      // Above the button when there is room, else below; inside the window.
      const b = rateB.getBoundingClientRect()
      const h = menu.offsetHeight, w = menu.offsetWidth
      const top = b.top - h - 4 >= 0 ? b.top - h - 4 : Math.min(window.innerHeight - h, b.bottom + 4)
      menu.style.top = `${Math.max(0, top)}px`
      menu.style.left = `${Math.max(0, Math.min(window.innerWidth - w, b.right - w))}px`
      rateB.setAttribute('aria-expanded', 'true')
      const on = menu.querySelector('.on') || menu.firstChild
      if (on) on.focus({ preventScroll: true })
    }
    function closeMenu(refocus) {
      if (menu.hidden) return
      menu.hidden = true
      rateB.setAttribute('aria-expanded', 'false')
      if (refocus) rateB.focus({ preventScroll: true })
    }
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.pod-mi')]
      const i = items.indexOf(document.activeElement)
      runKey(e, {
        ArrowDown: () => items[Math.min(items.length - 1, i + 1)].focus(),
        ArrowUp: () => items[Math.max(0, i - 1)].focus(),
        Home: () => items[0].focus(),
        End: () => items[items.length - 1].focus(),
        Escape: () => closeMenu(true),
        Tab: () => closeMenu(true),
      }, true)
    })
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== rateB && !rateB.contains(e.target)) closeMenu() }, true)
    window.addEventListener('blur', () => closeMenu())

    // ---------- drawing ----------

    function build() {
      track.textContent = ''
      marks.textContent = ''
      bars = []
      markEls = []
      if (!ep) return
      const d = total() || 1
      for (const [i, c] of ep.chapters.entries()) {
        const b = el('div', `pod-bar${c.step ? '' : ' map'}`)
        b.style.left = `${(c.start / d) * 100}%`
        b.style.width = `${(Math.max(0, Math.min(c.end, d) - c.start) / d) * 100}%`
        const fill = el('div', 'pod-fill')
        b.append(fill)
        track.append(b)
        bars.push({ el: b, fill, c })
        if (!c.step) continue
        const m = el('button', 'pod-mark')
        m.tabIndex = -1
        m.dataset.i = String(i)
        m.dataset.step = String(c.step)
        m.setAttribute('aria-label', `Go to ${partName(i)}`)
        m.addEventListener('pointerdown', (e) => e.stopPropagation())
        m.onclick = () => { seek(c.start); tl.focus({ preventScroll: true }) }
        m.addEventListener('pointerenter', () => showTip(c.start, m.getBoundingClientRect().left + m.offsetWidth / 2, i))
        m.addEventListener('pointerleave', hideTip)
        marks.append(m)
        markEls.push({ el: m, c, i })
      }
      layoutMarks()
    }

    /** The step marks under the bar: at their part's start, each at least MARK_MIN_PX wide, pushed apart where parts
     *  are narrower than that (then back from the end, so the last stays inside). */
    function layoutMarks() {
      const W = track.clientWidth
      if (!W || !markEls.length) return
      const d = total() || 1
      const want = markEls.map(({ c }) => ({ x: (c.start / d) * W, w: Math.max(MARK_MIN_PX, ((Math.min(c.end, d) - c.start) / d) * W) }))
      for (let k = 1; k < want.length; k++) want[k].x = Math.max(want[k].x, want[k - 1].x + MARK_MIN_PX)
      for (let k = want.length - 1; k >= 0; k--) {
        const limit = k + 1 < want.length ? want[k + 1].x : W
        want[k].x = Math.max(0, Math.min(want[k].x, limit - MARK_MIN_PX))
        want[k].w = Math.max(MARK_MIN_PX, Math.min(want[k].w, limit - want[k].x))
      }
      for (const [k, m] of markEls.entries()) {
        m.el.style.left = `${want[k].x}px`
        m.el.style.width = `${want[k].w}px`
        const num = want[k].w >= MARK_NUM_PX
        m.el.textContent = num ? String(m.c.step) : ''
        m.el.classList.toggle('dot', !num)
      }
    }

    function draw() {
      if (!ep) return
      const s = S()
      const d = s.dur || 1
      const t = s.t
      const ci = chapterAt(t)
      for (const [i, b] of bars.entries()) {
        const c = b.c
        const f = Math.max(0, Math.min(1, (t - c.start) / Math.max(0.001, Math.min(c.end, d) - c.start)))
        b.fill.style.width = `${f * 100}%`
        b.el.classList.toggle('cur', i === ci)
      }
      for (const m of markEls) m.el.classList.toggle('cur', m.i === ci)
      thumb.style.left = `${(Math.min(t, d) / d) * 100}%`
      // The part the audio can't reach (a cut file): greyed, and said on hover.
      const cut = s.reach > 0 && s.reach < d - CUT_S
      reachEl.hidden = !cut
      if (cut) {
        reachEl.style.left = `${(s.reach / d) * 100}%`
        reachEl.style.right = '0'
        reachEl.title = `The audio ends at ${clock(s.reach)}`
      }
      timeNow.textContent = clock(t)
      timeTotal.textContent = ` / ${clock(d)}`
      const nameNow = ci >= 0 ? partName(ci) : ''
      if (where.textContent !== nameNow) { where.textContent = nameNow; where.title = nameNow }
      const on = !!s.playing
      if (playB.dataset.on !== String(on)) {
        playB.dataset.on = String(on)
        playB.textContent = ''
        playB.append(icon(on ? 'pause' : 'play'))
        root.classList.toggle('on', on)
        if (opts.onListening) opts.onListening(on)
      }
      const playLabel = s.ended ? 'Replay' : on ? 'Pause' : 'Play'
      playB.title = `${playLabel} (Space or K · ${keyPrefix()} Space from the editor)`
      playB.setAttribute('aria-label', playLabel)
      rateB.textContent = rateText(s.rate || 1)
      rateB.title = `Playback speed (< >)`
      rateB.setAttribute('aria-label', `Playback speed, ${rateText(s.rate || 1)}`)
      if (muteB.dataset.on !== String(!!s.muted)) {
        muteB.dataset.on = String(!!s.muted)
        muteB.textContent = ''
        muteB.append(icon(s.muted ? 'muted' : 'vol'))
        muteB.title = s.muted ? 'Unmute (M)' : 'Mute (M)'
        muteB.setAttribute('aria-label', s.muted ? 'Unmute' : 'Mute')
        muteB.setAttribute('aria-pressed', String(!!s.muted))
      }
      // The slider: its value text with the total, said again only when the second or the part changes (F57).
      const sec = Math.floor(t)
      if (sec !== drawnSec || tl.dataset.part !== String(ci)) {
        drawnSec = sec
        tl.dataset.part = String(ci)
        tl.setAttribute('aria-valuemin', '0')
        tl.setAttribute('aria-valuemax', String(Math.round(d)))
        tl.setAttribute('aria-valuenow', String(sec))
        tl.setAttribute('aria-valuetext', `${spoken(t)} of ${spoken(d)}${nameNow ? `, ${nameNow}` : ''}`)
        tl.title = 'Position (← → 15 s · Shift+← → or Page Up / Page Down: a step · Home / End)'
      }
      // The step said once when it changes while playing (polite), never per frame.
      if (on && nameNow && nameNow !== saidWhere) live.textContent = nameNow
      saidWhere = nameNow
      // The error or note line.
      err.textContent = remoteErr(s)
      err.title = err.textContent
      err.hidden = !err.textContent
      err.classList.toggle('note', !!s.note)
      drawCaption(t, s)
      if (opts.onTick) opts.onTick(t, ci >= 0 ? ep.chapters[ci].step : 0, on)
      if (host) {
        // One clock: the extension gets each second this player shows.
        if (on && dragT === undefined && !seeking && Math.floor(audio.currentTime || 0) !== saidSec) report(false)
        mediaMeta(ci)
      }
    }
    /** The error line: a remote asking for Space says where to press it. */
    function remoteErr(s) {
      if (!s.err) return ''
      if (!host && /^Press Space to play/.test(s.err)) return 'Click ▶ in the Listen view to start'
      return s.err
    }

    // ---------- the caption: the sentence being said, in parts of two lines ----------

    /** Parts of the current segment, cached by segment and width: [{ start, end, html }]. */
    let capKey = ''
    let capParts = []
    function drawCaption(t, s) {
      const ended = !!s.ended
      endBox.hidden = !ended
      cap.hidden = ended
      if (ended) { drawEnd(); return }
      const si = segAt(t)
      const seg = si >= 0 ? ep.segments[si] : undefined
      const w = capText.clientWidth
      const key = `${ep.key}|${si}|${w}`
      if (key !== capKey) { capKey = key; capParts = seg ? captionParts(si, seg, w) : [] }
      let p = capParts[0]
      for (const x of capParts) if (t >= x.start) p = x
      const html = p ? p.html : ''
      if (capText.dataset.html !== html) {
        capText.dataset.html = html
        capText.innerHTML = html
      }
    }
    const escHtml = (x) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    /** Segment `seg` (index si) as caption parts: each sentence, split where it would need a third line. The speaker
     *  goes before the first part when the voice changed (and the episode has more than one). */
    function captionParts(si, seg, w) {
      const speakers = new Set(ep.segments.map((x) => x.speaker).filter(Boolean))
      const prev = si > 0 ? ep.segments[si - 1].speaker : ''
      const who = speakers.size > 1 && seg.speaker && seg.speaker !== prev ? `<b class="pod-who">${escHtml(cap1(seg.speaker))}:</b> ` : ''
      const out = []
      for (const [k, sen] of sentencesOf(seg).entries()) {
        const lead = k === 0 ? who : ''
        for (const piece of fitTwoLines(sen, lead, w)) out.push(piece)
      }
      return out
    }
    /** A sentence in parts that fit two lines at width `w` (measured), each timed from when its first word is said. */
    function fitTwoLines(sen, lead, w) {
      const words = sen.text.split(/\s+/).filter(Boolean)
      if (!w) return [{ start: sen.start, end: sen.end, html: lead + escHtml(sen.text) }]
      capMeasure.style.width = `${w}px`
      const lineH = parseFloat(getComputedStyle(capMeasure).lineHeight) || 18
      const fits = (html) => { capMeasure.innerHTML = html; return capMeasure.offsetHeight <= lineH * 2 + 2 }
      const groups = []
      let cur = []
      for (const word of words) {
        const next = [...cur, word]
        const html = (groups.length ? '' : lead) + escHtml(next.join(' '))
        if (cur.length && !fits(html)) { groups.push(cur); cur = [word] } else cur = next
      }
      if (cur.length) groups.push(cur)
      const chars = words.join(' ').length || 1
      // Each part from when its first word is said (the segment's clock: the marks anchor it), else by its share.
      const at = (c) => (sen.clock ? sen.clock(sen.off + c) : sen.start + ((sen.end - sen.start) * c) / chars)
      let c = 0
      return groups.map((g, k) => {
        const text = g.join(' ')
        const part = { start: at(c), end: at(c + text.length), html: (k === 0 ? lead : '') + escHtml(text) }
        c += text.length + 1
        return part
      })
    }

    /** The end of the episode: what it was, and what next. */
    function drawEnd() {
      if (endBox.dataset.key === ep.key + (ep.next ? ep.next.key : '')) return
      endBox.dataset.key = ep.key + (ep.next ? ep.next.key : '')
      endBox.textContent = ''
      endBox.append(el('span', 'pod-end-t', 'End of episode'))
      const acts = el('span', 'pod-end-a')
      const a = (cls, text, f) => { const b = el('button', `link ${cls}`, text); b.onclick = f; acts.append(b) }
      a('pod-replay', 'Replay', () => play(0))
      a('pod-walk', 'Walk it yourself', () => post({ type: 'podcastEnd', of: ep.key, action: 'walk' }))
      if (ep.next) {
        a('pod-nextj', 'Next journey', () => post({ type: 'podcastEnd', of: ep.key, action: 'next' }))
        acts.lastChild.title = `Listen to “${ep.next.title}”`
      }
      endBox.append(acts)
    }

    /** Smooth while playing and on screen; timeupdate (host) or the host's reports (remote) draw otherwise. */
    function tick() {
      cancelAnimationFrame(frame)
      if (!S().playing || reduced()) return
      frame = requestAnimationFrame(() => { draw(); tick() })
    }
    // A remote with reduced motion still moves its clock: once a second.
    if (!host) setInterval(() => { if (R.playing && reduced()) draw() }, 1000)

    // ---------- the Media Session: headphone keys and the system's "now playing" (host) ----------

    let metaKey = ''
    function mediaMeta(ci) {
      if (!host || !ep || !('mediaSession' in navigator)) return
      const k = `${ep.key}|${ci}`
      if (k === metaKey) return
      metaKey = k
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: ci >= 0 ? partName(ci) : ep.title, artist: ep.journey || ep.title, album: 'Code Notes' })
      } catch { /* not in this runtime */ }
    }
    function mediaPosition() {
      if (!host || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
      const d = audioDur()
      if (!d) return
      try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate, position: Math.min(d, audio.currentTime || 0) }) } catch { /* a bad state: skipped */ }
    }
    if (host && 'mediaSession' in navigator) {
      const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f) } catch { /* not supported */ } }
      on('play', () => play())
      on('pause', () => pause())
      on('seekbackward', () => skip(-SKIP_S))
      on('seekforward', () => skip(SKIP_S))
      on('previoustrack', () => part(-1))
      on('nexttrack', () => part(1))
      on('seekto', (d) => { if (d && typeof d.seekTime === 'number') seek(d.seekTime) })
    }

    // ---------- the timeline: hover, click, drag, keys ----------

    const timeAtX = (x) => {
      const r = track.getBoundingClientRect()
      return (Math.max(0, Math.min(r.width, x - r.left)) / (r.width || 1)) * (total() || 0)
    }
    /** The tip: the time, then the step (wrapped, never cut), over the pointer; a ghost line on the track. */
    function showTip(t, x, i) {
      if (!ep) return
      const ci = i !== undefined ? i : chapterAt(t)
      tip.textContent = ''
      tip.append(el('span', 'pod-tip-time', clock(t)), el('span', 'pod-tip-part', partName(ci)))
      if (reach() && t > reach() + 0.05) tip.append(el('span', 'pod-tip-cut', 'the audio ends before this'))
      tip.hidden = false
      const r = tl.getBoundingClientRect()
      const w = tip.offsetWidth
      tip.style.left = `${Math.max(0, Math.min(r.width - w, x - r.left - w / 2))}px`
      ghost.hidden = false
      ghost.style.left = `${Math.max(0, Math.min(r.width, x - r.left))}px`
    }
    function hideTip() {
      if (dragT !== undefined) return
      tip.hidden = true
      ghost.hidden = true
    }
    track.parentElement.addEventListener('pointermove', (e) => {
      if (!ep || (e.target && e.target.closest && e.target.closest('.pod-mark'))) return
      const t = timeAtX(e.clientX)
      showTip(t, e.clientX)
      if (dragT !== undefined) { dragT = t; draw() }
    })
    tl.addEventListener('pointerleave', hideTip)
    // A webview can miss the leave (the pointer left the frame): the tip goes then too.
    document.addEventListener('pointerleave', hideTip)
    document.addEventListener('pointermove', (e) => { if (!tip.hidden && dragT === undefined && !tl.contains(e.target)) hideTip() })
    window.addEventListener('blur', hideTip)
    document.addEventListener('visibilitychange', hideTip)
    tl.addEventListener('pointerdown', (e) => {
      if (!ep || e.button !== 0) return
      e.preventDefault()
      tl.setPointerCapture(e.pointerId)
      tl.focus({ preventScroll: true })
      dragT = timeAtX(e.clientX)
      root.classList.add('dragging')
      draw()
    })
    const endDrag = (commit) => {
      if (dragT === undefined) return
      const t = dragT
      dragT = undefined
      root.classList.remove('dragging')
      hideTip()
      if (commit) seek(t)
      else draw()
    }
    tl.addEventListener('pointerup', () => endDrag(true))
    tl.addEventListener('pointercancel', () => endDrag(false))
    tl.addEventListener('lostpointercapture', () => endDrag(true))
    // The slider's keys (the ARIA pattern): ↑ → on, ↓ ← back (15 s); Home, End; Page Up / Down a step.
    tl.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      runKey(e, {
        Escape: dragT !== undefined && (() => endDrag(false)),
        Home: () => seek(0),
        End: () => seek(total()),
        PageUp: () => part(-1),
        PageDown: () => part(1),
        ArrowUp: () => skip(SKIP_S),
        ArrowDown: () => skip(-SKIP_S),
      }, true)
    })

    // Space / K play and pause anywhere in the view but where you type; M mutes; < > change the speed. A button the
    // keyboard went to (Tab) presses itself with Space; one clicked with the mouse doesn't keep Space (after a beat's
    // ‹ ›, Space pauses; it doesn't step back again). ← → skip, Shift+← → a step: in the player, or with nothing else
    // focused (the animation and the map keep their own arrows). K and M by the key's place (Caps Lock, any layout).
    const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
    const CONTROL = 'button, a, [role="button"], [role="link"], summary'
    /** The control last pressed with the pointer (it has the focus, but not for Space); Tab forgets it. */
    let clicked
    document.addEventListener('pointerdown', (e) => { clicked = (e.target && e.target.closest && e.target.closest(CONTROL)) || undefined }, true)
    document.addEventListener('keydown', (e) => { if (e.key === 'Tab') clicked = undefined }, true)
    document.addEventListener('keydown', (e) => {
      if (!ep || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target
      if (typing(target) || menu.contains(target)) return
      const inBar = root.contains(target)
      const free = target === document.body || target === document.documentElement || !target
      const control = target && target.closest && target.closest(CONTROL)
      const onButton = !!control && control !== clicked
      const byCode = { KeyK: toggle, KeyM: () => setMuted(!S().muted) }
      if (!e.shiftKey && Object.hasOwn(byCode, e.code)) { e.preventDefault(); e.stopPropagation(); byCode[e.code](); return }
      const rate = (dir) => () => { const i = RATES.indexOf(S().rate); setRate(RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 1 : i) + dir))]) }
      runKey(e, {
        ' ': !onButton && toggle,
        '<': rate(-1),
        '>': rate(1),
        ArrowLeft: (inBar || free) && (() => (e.shiftKey ? part(-1) : skip(-SKIP_S))),
        ArrowRight: (inBar || free) && (() => (e.shiftKey ? part(1) : skip(SKIP_S))),
      }, true)
    })

    // ---------- the audio's events (host) ----------

    if (host) {
      audio.addEventListener('loadedmetadata', () => {
        if (ep && Number.isFinite(audio.duration)) post({ type: 'podcastMeta', of: ep.key, duration: audio.duration })
        const to = Math.min(startAt, Math.max(0, reach() - 0.05))
        startAt = 0
        build()
        if (to > 0) {
          seeking = { to, asked: false }
          audio.currentTime = to
          if (blobbed) report(true, to)
        } else report(true) // Where it starts, said once it is there (the walk, when it follows this podcast, goes there).
        draw()
      })
      audio.addEventListener('seeked', () => { seeked(); draw() })
      audio.addEventListener('timeupdate', () => {
        if (untilCheck()) return
        if (dragT === undefined) draw()
        if (!seeking) report(false)
        frozenCheck()
      })
      audio.addEventListener('play', () => { askFocus = false; endedSelf = false; if (!errNote) showError(''); movedT = -1; draw(); tick(); report(false) })
      audio.addEventListener('pause', () => { draw(); report(false) })
      audio.addEventListener('ended', () => { endedSelf = true; held = false; until = undefined; draw(); report(false) })
      audio.addEventListener('ratechange', () => { draw(); report(false) })
      audio.addEventListener('volumechange', () => { draw(); postState() })
      audio.addEventListener('error', () => {
        if (!audio.getAttribute('src')) return // emptied on purpose (another episode, none)
        const e = audio.error
        seeking = undefined
        // Not playing: never "playing" with the clock still.
        if (!audio.paused) audio.pause()
        say(`audio error ${e ? e.code : '?'}${e && e.message ? `: ${e.message}` : ''}`)
        showError("Can't play the audio")
        report(false)
      })
      // timeupdate stops when the clock does: the check runs on its own too.
      setInterval(frozenCheck, 1000)
    }
    /** Playing with the clock still for FROZEN_MS (a cut or broken file): paused, and said. */
    function frozenCheck() {
      if (!hostPlaying() || seeking) { movedT = -1; return }
      const t = audio.currentTime
      if (t !== movedT) { movedT = t; movedAt = Date.now(); return }
      if (Date.now() - movedAt < FROZEN_MS) return
      audio.pause()
      showError(`The audio doesn't play on from ${clock(t)}`)
      say(`the audio stopped at ${clock(t)} while playing (readyState ${audio.readyState}, networkState ${audio.networkState})`)
    }

    // The player's height, for the panel's layout (the map's column and the page's end stay clear of it); the marks
    // laid out again at a new width. Set a frame later, and only when it changed: set inside the observer it resized
    // the map, whose own observer then looped ("ResizeObserver loop completed with undelivered notifications").
    let podH = ''
    let markW = 0
    new ResizeObserver(() => requestAnimationFrame(() => {
      if (track.clientWidth !== markW) { markW = track.clientWidth; layoutMarks(); capKey = ''; draw() }
      if (opts.mount) return
      const h = root.hidden ? '0px' : `${root.offsetHeight}px`
      if (h === podH) return
      podH = h
      document.documentElement.style.setProperty('--podH', h)
    })).observe(root)

    /** No episode (none, or unavailable): the audio unloaded (host). */
    function unload() {
      if (!host || !ep) return
      report(false)
      loadGen++
      loading = false
      wantPlay = false
      seeking = undefined
      until = undefined
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined }
    }

    return {
      el: root,
      /** The episode (none: the player goes; host: the same journey's same audio again keeps playing). */
      set(e) {
        const unavailable = e && e.unavailable
        note.hidden = !(e && (e.notice || unavailable))
        noteText.textContent = unavailable ? 'Podcast unavailable' : (e && e.notice) || ''
        note.title = unavailable || (e && e.notice) || ''
        root.classList.toggle('unavail', !!unavailable)
        if (unavailable) e = undefined
        if (!e) {
          unload()
          ep = undefined
          root.hidden = !unavailable
          if (!opts.mount) document.body.classList.toggle('has-pod', !!unavailable)
          if (!unavailable && !opts.mount) {
            podH = '0px'
            document.documentElement.style.setProperty('--podH', '0px')
          }
          if (playB.dataset.on === 'true' && opts.onListening) opts.onListening(false)
          playB.dataset.on = ''
          root.classList.remove('on')
          if (opts.onShown) opts.onShown(false)
          return
        }
        const same = ep && ep.key === e.key && ep.src === e.src
        if (host) {
          // Another episode: where the one leaving was is said first (kept for next time).
          if (ep && !same) { held = false; audio.pause(); report(false) }
        } else if (!same) {
          R = { t: e.at || 0, playing: false, held: false, rate: e.rate || 1, muted: !!e.muted, ready: false, loading: false, ended: false, dur: 0, reach: 0, err: '', note: false, sent: 0 }
          rAt = performance.now()
          asked = undefined
        }
        ep = e
        root.hidden = false
        if (!opts.mount) document.body.classList.add('has-pod')
        if (host && !same) {
          errText = ''
          errNote = false
          resumeAt = undefined
          until = undefined
          endedSelf = false
          startAt = e.at || 0
          wantPlay = !!e.play
          setRate(RATES.includes(e.rate) ? e.rate : 1)
          audio.muted = !!e.muted
          load(e)
        }
        capKey = ''
        endBox.dataset.key = ''
        build()
        draw()
        postState()
        if (opts.onShown) opts.onShown(true)
      },
      /** The extension's command (host). */
      cmd(m) {
        if (!ep || !host) return
        const actions = {
          play: () => play(typeof m.at === 'number' ? m.at : undefined, typeof m.until === 'number' ? m.until : undefined),
          toggle,
          // With a note: the walk is on a step the podcast skips; ▶ goes on from `resumeAt`.
          pause: () => {
            if (m.hold) { hold(); return }
            pause()
            if (m.note) showError(String(m.note), true)
            if (typeof m.resumeAt === 'number') resumeAt = m.resumeAt
          },
          // A quiet line in the player (the camera waiting before the code moves); '' clears it.
          unhold,
          note: () => showError(String(m.text || ''), true),
          skip: () => skip(Number(m.by) || 0),
          seek: () => seek(Number(m.to) || 0, !m.reader),
          part: () => part(m.dir < 0 ? -1 : 1),
          rate: () => setRate(RATES.includes(Number(m.rate)) ? Number(m.rate) : 1),
          mute: () => setMuted(typeof m.muted === 'boolean' ? m.muted : !audio.muted),
          focus: () => playB.focus({ preventScroll: true }),
        }
        if (Object.hasOwn(actions, m.action)) actions[m.action]()
      },
      /** The host's state (remote). */
      hostState(m) {
        if (host || !ep || m.of !== ep.key) return
        // A report from before the seek just asked for: the time asked stays until the host says it moved.
        if (asked && !m.seek && performance.now() - asked.at < ASK_STALE_MS) return
        asked = undefined
        R = { t: m.t || 0, playing: !!m.playing, held: !!m.held, rate: m.rate || 1, muted: !!m.muted, ready: !!m.ready, loading: !!m.loading, ended: !!m.ended, dur: m.dur || 0, reach: m.reach || 0, err: m.err || '', note: !!m.note, sent: Number(m.sent) || 0 }
        for (const k of Object.keys(pend)) {
          if (R[k] === pend[k].v || performance.now() - pend[k].at > ASK_STALE_MS) delete pend[k]
          else R[k] = pend[k].v
        }
        rAt = performance.now()
        draw()
        tick()
      },
      /** Plays one step and stops at its end (▶ on a storyline row). */
      playStep(n) {
        if (!ep) return
        const cs = ep.chapters
        const i = cs.findIndex((c) => c.step === n)
        if (i < 0) return
        let j = i
        while (j + 1 < cs.length && cs[j + 1].step === n) j++
        play(cs[i].start, cs[j].end)
      },
      /** Plays from second `t` (the intro's or the recap's row). */
      playFrom(t) { play(t) },
      /** To second `t` (a sentence of the transcript). */
      seek(t) { seek(t) },
      /** The episode shown (the storyline's chapter list reads it). */
      get episode() { return ep },
      /** The time and the playing state shown. */
      get now() { const s = S(); return { t: s.t, playing: !!s.playing, ended: !!s.ended } },
      sentencesOf,
      /** For tests: the audio's state (host). */
      get state() {
        const s = S()
        return { ...s, paused: host ? audio.paused : !s.playing, currentTime: host ? audio.currentTime : undefined, duration: s.dur, error: err.hidden ? '' : err.textContent, note: note.hidden ? '' : noteText.textContent, blob: blobbed, caption: cap.hidden ? '' : capText.textContent }
      },
      get shown() { return !!ep },
      /** The journey's titles changed (another journey of the same id, a rename): the tip and labels follow. */
      redraw() { if (ep) { build(); draw() } },
    }
  }
  window.JourneyPodcast.clock = clock
})()
