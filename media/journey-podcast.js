// The journey's podcast player: a bar at the bottom of the journey panel with the audio, its controls and a timeline
// marked by step. The audio plays here (a webview kept alive while hidden: retainContextWhenHidden), so it goes on
// while the panel is in a background tab or VS Code has no focus. Where the journey should be at a time is the
// extension's to work out (src/podcast/): this bar only plays, seeks and says where the audio is. It lives outside
// #app, so journey-map.js's re-renders never touch it (a drag or the audio survive them).
// Needs common.js. Made by journey-map.js: JourneyPodcast({ post, stepTitle(n), onShown(h) }).
//
// The audio is loaded whole (fetch, then a blob: URL) before it plays: a server that ignores HTTP Range (VS Code for
// the web, and remote windows) serves media Chromium can't seek in, and a seek there lands at 0:00. If the fetch
// fails, the file's own URL plays, and where a seek lands is what the audio says once it is done, never the time asked.
//
// In (journey-map.js routes them here):
//   { type: 'podcast', episode? }  the journey's episode ({ key, src, title, duration, at, play?, rate, chapters,
//                                  segments }), or none (the bar goes). `at`: where it starts; `play`: it plays once loaded
//   { type: 'podcastCmd', action: 'play' | 'pause' | 'toggle' | 'skip' | 'seek' | 'part' | 'rate', by?, to?, dir?, at?,
//                         note?, resumeAt? }   play `at`: from there; pause `note`: said in the bar; `resumeAt`: where
//                                              the next ▶ starts (the walk is on a step the podcast skips)
// Out:
//   { type: 'podcastTime', of, t, playing, rate, seek? }  where episode `of`'s audio is (seek: moved by a seek, not by
//                                                         playing); said each time the shown second changes too
//   { type: 'podcastError', message }  what went wrong (the extension logs it)
;(function () {
  const { el, svgEl, runKey } = window.common

  /** Back / forward (s). */
  const SKIP_S = 15
  /** Speeds the speed button cycles through. */
  const RATES = [1, 1.25, 1.5]
  /** Within this many seconds of a part's start, ⏮ goes to the part before (as src/podcast/model.ts chapterJump). */
  const RESTART_GRACE_S = 3
  /** A seek that lands further than this from where it was asked to go (s) did not get there. */
  const MISS_S = 0.75
  /** Playing, the clock not moving for this long (ms): it is not playing (a broken or cut file); it pauses and says so. */
  const FROZEN_MS = 3000

  const PATHS = {
    play: 'M5 3.5v13l11-6.5z',
    pause: 'M5 3h3.5v14H5zM11.5 3H15v14h-3.5z',
    prev: 'M4 3h2v14H4zM16 3v14L7 10z',
    next: 'M14 3h2v14h-2zM4 3v14l9-7z',
  }
  function icon(name) {
    const s = svgEl('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true' })
    s.append(svgEl('path', { d: PATHS[name], fill: 'currentColor' }))
    return s
  }
  /** "Back 15" / "Forward 15": a curved arrow with the seconds in it. */
  function skipIcon(dir) {
    const s = svgEl('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': 'true' })
    const arc = dir < 0 ? 'M10 3.5a6.5 6.5 0 1 1-6.1 4.3' : 'M10 3.5a6.5 6.5 0 1 0 6.1 4.3'
    const head = dir < 0 ? 'M10 1v5L6.5 3.5z' : 'M10 1v5l3.5-2.5z'
    s.append(svgEl('path', { d: arc, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }), svgEl('path', { d: head, fill: 'currentColor' }))
    const t = svgEl('text', { x: 10, y: 13.3, 'text-anchor': 'middle', 'font-size': 6.5, fill: 'currentColor' })
    t.textContent = String(SKIP_S)
    s.append(t)
    return s
  }
  function clock(t) {
    const s = Math.max(0, Math.floor(t || 0))
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
    return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`
  }
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  window.JourneyPodcast = function (opts) {
    const { post } = opts
    const audio = el('audio')
    audio.preload = 'metadata'
    const root = el('div', 'pod')
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', 'Podcast')
    root.hidden = true

    // The timeline: one bar per part (step), filled as it plays; a thumb; the hover tip.
    const tl = el('div', 'pod-tl')
    tl.tabIndex = 0
    tl.setAttribute('role', 'slider')
    tl.setAttribute('aria-label', 'Position')
    const track = el('div', 'pod-track')
    const thumb = el('div', 'pod-thumb')
    const tip = el('div', 'pod-tip')
    tip.hidden = true
    tl.append(track, thumb, tip)

    const btn = (cls, label, child, onClick) => {
      const b = el('button', `pod-b ${cls}`)
      b.title = label
      b.setAttribute('aria-label', label)
      b.append(child)
      b.onclick = onClick
      return b
    }
    const prevB = btn('prev', 'Previous step', icon('prev'), () => part(-1))
    const backB = btn('back', `Back ${SKIP_S} s (←)`, skipIcon(-1), () => skip(-SKIP_S))
    const playB = btn('play', 'Play (Space)', icon('play'), () => toggle())
    const fwdB = btn('fwd', `Forward ${SKIP_S} s (→)`, skipIcon(1), () => skip(SKIP_S))
    const nextB = btn('next', 'Next step', icon('next'), () => part(1))
    const time = el('span', 'pod-time')
    const rateB = el('button', 'pod-rate', '1×')
    rateB.title = 'Speed'
    rateB.onclick = () => setRate(RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] || 1)
    const cap = el('div', 'pod-cap')
    // An error, or a note ("not in the podcast"): one short line beside the time.
    const err = el('span', 'pod-err')
    err.hidden = true
    err.setAttribute('role', 'status')
    const row = el('div', 'pod-row')
    const ctl = el('div', 'pod-ctl')
    ctl.append(prevB, backB, playB, fwdB, nextB)
    row.append(ctl, time, err, rateB)
    root.append(tl, row, cap, audio)
    document.body.append(root)

    /** The episode shown ({ src, duration, chapters: [{ start, end, step }], segments: [{ start, end, text, step }] }). */
    let ep
    /** The chapter bars ({ el, fill, c }). */
    let bars = []
    /** A drag on the timeline: the time it would seek to (undefined: none). */
    let dragT
    /** The time to seek to once the audio can (an episode set before its metadata). */
    let startAt = 0
    let boundaryTimer = 0
    let frame = 0
    /** The audio's blob: URL (undefined: none, or it plays from the file's own URL), and which load is the newest. */
    let blobUrl
    let loadGen = 0
    /** The audio is still being fetched: no source yet. Play asked meanwhile (`wantPlay`) starts once it is there. */
    let loading = false
    let wantPlay = false
    /** The audio is a blob, so a seek always gets there (said at once); else where it got is said once it is done. */
    let blobbed = false
    /** A seek under way: where to, and whether the extension asked for it (the walk moved first). */
    let seeking
    /** Where the next ▶ starts, set by the extension while the walk is on a step the podcast skips. */
    let resumeAt
    /** The whole second last said to the extension (the status bar shows the same clock as the bar). */
    let saidSec = -1
    /** The time last seen moving, and when (FROZEN_MS). */
    let movedT = -1
    let movedAt = 0
    /** Play was refused for want of a click or key here: ▶ takes the keyboard when the panel gets it. */
    let askFocus = false
    window.addEventListener('focus', () => { if (askFocus) playB.focus({ preventScroll: true }) })

    const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (ep && ep.duration) || 0)
    const now = () => (dragT !== undefined ? dragT : seeking ? seeking.to : audio.readyState < 1 ? startAt : audio.currentTime || 0)
    const playing = () => !audio.paused && !audio.ended
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
    /** What a part is called on the tip and to a screen reader: "3 · title", or Intro / Map / Recap. */
    function partName(i) {
      const c = ep.chapters[i]
      if (c.step) return `${c.step} · ${opts.stepTitle(c.step) || `Step ${c.step}`}`
      if (i === 0) return 'Intro'
      return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
    }

    /** Says where the audio is: always what the audio itself reports (`t` only for a seek a blob is sure to make). */
    function report(seek, t) {
      // Nothing to say before this episode's audio is there (an event of the one before it).
      if (!ep || (t === undefined && (loading || audio.readyState < 1))) return
      const at = t !== undefined ? t : audio.currentTime || 0
      saidSec = Math.floor(at)
      post({ type: 'podcastTime', of: ep.key, t: at, playing: playing(), rate: audio.playbackRate, ...(seek ? { seek: true } : {}) })
      scheduleBoundary()
    }
    /** A line for the extension's log. */
    const say = (message) => post({ type: 'podcastError', message })
    /** Says where the audio is again right as the next segment starts (timeupdate comes only every ~250 ms). */
    function scheduleBoundary() {
      clearTimeout(boundaryTimer)
      if (!ep || !playing()) return
      const t = audio.currentTime
      const next = ep.segments.find((s) => s.start > t + 0.01)
      if (!next) return
      const ms = ((next.start - t) / (audio.playbackRate || 1)) * 1000 + 20
      boundaryTimer = setTimeout(() => report(false), Math.max(20, ms))
    }

    /** To second `t`. `asked`: the extension asked (the walk is there already). */
    function seek(t, asked) {
      if (!ep) return
      resumeAt = undefined
      if (err.classList.contains('note')) showError('')
      const d = duration()
      const to = Math.max(0, Math.min(d ? d - 0.05 : t, t))
      if (audio.readyState < 1) {
        // Not loaded yet: it goes there once it is (loadedmetadata), and says so then.
        startAt = to
        draw()
        return
      }
      seeking = { to, asked: !!asked }
      audio.currentTime = to
      draw()
      // A blob always gets there: said at once, so the journey moves now, not once the audio has the place decoded.
      if (blobbed) report(true, to)
    }
    /** A seek done: where the audio is now is what counts. Somewhere else than asked (the source can't seek): logged,
     *  said in the bar; the walk follows the audio, unless the walk moved first (then the audio pauses there). */
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
    const skip = (by) => seek(now() + by)
    function part(dir) {
      if (!ep) return
      const t = now()
      const cs = ep.chapters
      const i = chapterAt(t)
      if (dir > 0) seek(i + 1 < cs.length ? cs[i + 1].start : duration())
      else seek(t - cs[i].start > RESTART_GRACE_S || i === 0 ? cs[i].start : cs[i - 1].start)
    }
    function play() {
      if (!ep) return
      // Still fetching: it plays once it is there.
      if (loading) { wantPlay = true; return }
      if (resumeAt !== undefined) seek(resumeAt)
      else if (audio.ended) seek(0)
      if (err.classList.contains('note')) showError('')
      movedT = -1
      const p = audio.play()
      if (p && p.catch) p.catch((e) => {
        // A pause before it started (a quick Space, Space): nothing went wrong.
        if (e && e.name === 'AbortError') return
        // VS Code's webviews play audio only after a click or a key in them (once per panel): ▶ takes the keyboard.
        const gesture = e && e.name === 'NotAllowedError'
        // Not playing: never "playing" with the clock still.
        if (!audio.paused) audio.pause()
        showError(gesture ? 'Press Space to play' : `Can't play: ${e && e.message}`)
        if (gesture) { askFocus = true; playB.focus({ preventScroll: true }) }
        post({ type: 'podcastError', message: String(e && (e.name || e.message)) })
        draw()
        report(false)
      })
    }
    function pause() {
      wantPlay = false
      audio.pause()
      draw()
    }
    const toggle = () => (playing() || wantPlay ? pause() : play())
    function setRate(r) {
      audio.playbackRate = r
      audio.defaultPlaybackRate = r
    }
    function showError(text, note) {
      err.textContent = text
      err.title = text
      err.hidden = !text
      err.classList.toggle('note', !!text && !!note)
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
        if (wantPlay) { wantPlay = false; play() }
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

    // ---------- drawing ----------

    function build() {
      track.textContent = ''
      bars = []
      const d = duration() || 1
      for (const [i, c] of ep.chapters.entries()) {
        const b = el('div', `pod-bar${c.step ? '' : ' map'}`)
        b.style.left = `${(c.start / d) * 100}%`
        b.style.width = `${(Math.max(0, Math.min(c.end, d) - c.start) / d) * 100}%`
        const fill = el('div', 'pod-fill')
        b.append(fill)
        b.dataset.i = String(i)
        track.append(b)
        bars.push({ el: b, fill, c })
      }
    }

    function draw() {
      if (!ep) return
      const d = duration() || 1
      const t = now()
      const ci = chapterAt(t)
      for (const [i, b] of bars.entries()) {
        const c = b.c
        const f = Math.max(0, Math.min(1, (t - c.start) / Math.max(0.001, Math.min(c.end, d) - c.start)))
        b.fill.style.width = `${f * 100}%`
        b.el.classList.toggle('cur', i === ci)
      }
      thumb.style.left = `${(Math.min(t, d) / d) * 100}%`
      time.textContent = `${clock(t)} / ${clock(d)}`
      const on = playing()
      if (playB.dataset.on !== String(on)) {
        playB.dataset.on = String(on)
        playB.textContent = ''
        playB.append(icon(on ? 'pause' : 'play'))
        playB.title = on ? 'Pause (Space)' : 'Play (Space)'
        playB.setAttribute('aria-label', on ? 'Pause' : 'Play')
        root.classList.toggle('on', on)
      }
      rateB.textContent = `${audio.playbackRate}×`
      tl.setAttribute('aria-valuemin', '0')
      tl.setAttribute('aria-valuemax', String(Math.round(d)))
      tl.setAttribute('aria-valuenow', String(Math.round(t)))
      tl.setAttribute('aria-valuetext', `${clock(t)}, ${ci >= 0 ? partName(ci) : ''}`)
      const si = segAt(t)
      const text = si >= 0 ? ep.segments[si].text : ''
      if (cap.textContent !== text) { cap.textContent = text; cap.title = text }
      // One clock: the status bar gets each second this bar shows.
      if (on && dragT === undefined && !seeking && Math.floor(audio.currentTime || 0) !== saidSec) report(false)
    }

    /** Smooth while playing and on screen; timeupdate draws otherwise. */
    function tick() {
      cancelAnimationFrame(frame)
      if (!playing() || reduced()) return
      frame = requestAnimationFrame(() => { draw(); tick() })
    }

    // ---------- the timeline: hover, click, drag, keys ----------

    const timeAtX = (x) => {
      const r = track.getBoundingClientRect()
      return (Math.max(0, Math.min(r.width, x - r.left)) / (r.width || 1)) * duration()
    }
    function showTip(t, x) {
      const i = chapterAt(t)
      tip.textContent = ''
      tip.append(el('b', '', partName(i)), el('span', '', clock(t)))
      tip.hidden = false
      const r = tl.getBoundingClientRect()
      const w = tip.offsetWidth
      tip.style.left = `${Math.max(0, Math.min(r.width - w, x - r.left - w / 2))}px`
    }
    tl.addEventListener('pointermove', (e) => {
      if (!ep) return
      const t = timeAtX(e.clientX)
      showTip(t, e.clientX)
      if (dragT !== undefined) { dragT = t; draw() }
    })
    tl.addEventListener('pointerleave', () => { if (dragT === undefined) tip.hidden = true })
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
      tip.hidden = true
      if (commit) seek(t)
      else draw()
    }
    tl.addEventListener('pointerup', () => endDrag(true))
    tl.addEventListener('pointercancel', () => endDrag(false))
    tl.addEventListener('lostpointercapture', () => endDrag(true))
    tl.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      runKey(e, {
        Escape: dragT !== undefined && (() => endDrag(false)),
        Home: () => seek(0),
        End: () => seek(duration()),
        PageUp: () => part(-1),
        PageDown: () => part(1),
      }, true)
    })

    // Space / K play and pause anywhere in the panel but where you type. A button the keyboard went to (Tab) presses
    // itself with Space; one clicked with the mouse doesn't keep Space (after a beat's ‹ ›, Space pauses; it doesn't
    // step back again). ← → skip, Shift+← → a step: in the bar, or with nothing else focused (the animation and the
    // map keep their own arrows).
    const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
    const CONTROL = 'button, a, [role="button"], [role="link"]'
    /** The control last pressed with the pointer (it has the focus, but not for Space); Tab forgets it. */
    let clicked
    document.addEventListener('pointerdown', (e) => { clicked = (e.target && e.target.closest && e.target.closest(CONTROL)) || undefined }, true)
    document.addEventListener('keydown', (e) => { if (e.key === 'Tab') clicked = undefined }, true)
    document.addEventListener('keydown', (e) => {
      if (!ep || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target
      if (typing(target)) return
      const inBar = root.contains(target)
      const free = target === document.body || target === document.documentElement || !target
      const control = target && target.closest && target.closest(CONTROL)
      const onButton = !!control && control !== clicked
      runKey(e, {
        ' ': !onButton && toggle,
        k: toggle,
        K: toggle,
        ArrowLeft: (inBar || free) && (() => (e.shiftKey ? part(-1) : skip(-SKIP_S))),
        ArrowRight: (inBar || free) && (() => (e.shiftKey ? part(1) : skip(SKIP_S))),
      }, true)
    })

    // ---------- the audio ----------

    audio.addEventListener('loadedmetadata', () => {
      const to = Math.min(startAt, duration())
      startAt = 0
      build()
      if (to > 0) {
        seeking = { to, asked: false }
        audio.currentTime = to
        if (blobbed) report(true, to)
      }
      // Where it starts, said once it is there (the walk, when it follows this podcast, goes there).
      else report(true)
      draw()
    })
    audio.addEventListener('seeked', () => { seeked(); draw() })
    audio.addEventListener('timeupdate', () => {
      if (dragT === undefined) draw()
      if (!seeking) report(false)
      frozenCheck()
    })
    audio.addEventListener('play', () => { askFocus = false; if (!err.classList.contains('note')) showError(''); movedT = -1; draw(); tick(); report(false) })
    audio.addEventListener('pause', () => { draw(); report(false) })
    audio.addEventListener('ended', () => { draw(); report(false) })
    audio.addEventListener('ratechange', () => { draw(); report(false) })
    audio.addEventListener('error', () => {
      if (!audio.getAttribute('src')) return // emptied on purpose (another episode, none)
      const e = audio.error
      showError("Can't play the audio")
      seeking = undefined
      // Not playing: never "playing" with the clock still.
      if (!audio.paused) audio.pause()
      say(`audio error ${e ? e.code : '?'}${e && e.message ? `: ${e.message}` : ''}`)
      draw()
      report(false)
    })
    /** Playing with the clock still for FROZEN_MS (a cut or broken file): paused, and said. */
    function frozenCheck() {
      if (!playing() || seeking) { movedT = -1; return }
      const t = audio.currentTime
      if (t !== movedT) { movedT = t; movedAt = Date.now(); return }
      if (Date.now() - movedAt < FROZEN_MS) return
      audio.pause()
      showError(`The audio doesn't play on from ${clock(t)}`)
      say(`the audio stopped at ${clock(t)} while playing (readyState ${audio.readyState}, networkState ${audio.networkState})`)
    }
    // timeupdate stops when the clock does: the check runs on its own too.
    setInterval(frozenCheck, 1000)

    // The bar's height, for the panel's layout (the map's column and the page's end stay clear of it).
    // Set a frame later, and only when it changed: set inside the observer it resized the map, whose own observer then
    // looped ("ResizeObserver loop completed with undelivered notifications").
    let podH = ''
    new ResizeObserver(() => requestAnimationFrame(() => {
      const h = root.hidden ? '0px' : `${root.offsetHeight}px`
      if (h === podH) return
      podH = h
      document.documentElement.style.setProperty('--podH', h)
    })).observe(root)

    return {
      el: root,
      /** The journey's episode (none: the bar goes; the same journey's same audio again keeps playing). */
      set(e) {
        if (!e) {
          if (ep) {
            report(false)
            loadGen++
            loading = false
            wantPlay = false
            seeking = undefined
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
            if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined }
          }
          ep = undefined
          root.hidden = true
          document.body.classList.remove('has-pod')
          podH = '0px'
          document.documentElement.style.setProperty('--podH', '0px')
          if (opts.onShown) opts.onShown(false)
          return
        }
        const same = ep && ep.key === e.key && ep.src === e.src
        // Another episode: where the one leaving was is said first (kept for next time).
        if (ep && !same) { audio.pause(); report(false) }
        ep = e
        root.hidden = false
        document.body.classList.add('has-pod')
        if (!same) {
          showError('')
          resumeAt = undefined
          startAt = e.at || 0
          wantPlay = !!e.play
          setRate(RATES.includes(e.rate) ? e.rate : 1)
          load(e)
        }
        build()
        draw()
        if (opts.onShown) opts.onShown(true)
      },
      cmd(m) {
        if (!ep) return
        const actions = {
          play: () => { if (typeof m.at === 'number') seek(m.at); play() },
          toggle,
          // With a note: the walk is on a step the podcast skips; ▶ goes on from `resumeAt`.
          pause: () => {
            pause()
            if (m.note) showError(String(m.note), true)
            if (typeof m.resumeAt === 'number') resumeAt = m.resumeAt
          },
          skip: () => skip(Number(m.by) || 0),
          seek: () => seek(Number(m.to) || 0, true),
          part: () => part(m.dir < 0 ? -1 : 1),
          rate: () => setRate(Number(m.rate) || 1),
        }
        if (Object.hasOwn(actions, m.action)) actions[m.action]()
      },
      /** For tests: the audio's state. */
      get state() { return { t: audio.currentTime, playing: playing(), paused: audio.paused, ready: audio.readyState, duration: duration(), error: err.hidden ? '' : err.textContent, blob: blobbed } },
      get shown() { return !!ep },
      /** The journey's titles changed (another journey of the same id, a rename): the tip and labels follow. */
      redraw() { if (ep) draw() },
    }
  }
})()
