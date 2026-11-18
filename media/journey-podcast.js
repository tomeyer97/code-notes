// The journey's podcast player: a bar at the bottom of the journey panel with the audio, its controls and a timeline
// marked by step. The audio plays here (a webview kept alive while hidden: retainContextWhenHidden), so it goes on
// while the panel is in a background tab or VS Code has no focus. Where the journey should be at a time is the
// extension's to work out (src/podcast/): this bar only plays, seeks and says where the audio is. It lives outside
// #app, so journey-map.js's re-renders never touch it (a drag or the audio survive them).
// Needs common.js. Made by journey-map.js: JourneyPodcast({ post, stepTitle(n), onShown(h) }).
//
// In (journey-map.js routes them here):
//   { type: 'podcast', episode? }  the journey's episode ({ src, title, duration, at, rate, chapters, segments }), or
//                                  none (the bar goes)
//   { type: 'podcastCmd', action: 'play' | 'pause' | 'toggle' | 'skip' | 'seek' | 'part', by?, to?, dir? }
// Out:
//   { type: 'podcastTime', t, playing, rate, seek? }   where the audio is (seek: moved by a seek, not by playing)
//   { type: 'podcastError', message }
;(function () {
  const { el, svgEl, runKey } = window.common

  /** Back / forward (s). */
  const SKIP_S = 15
  /** Speeds the speed button cycles through. */
  const RATES = [1, 1.25, 1.5]
  /** Within this many seconds of a part's start, ⏮ goes to the part before (as src/podcast/model.ts chapterJump). */
  const RESTART_GRACE_S = 3

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
    const err = el('span', 'pod-err')
    err.hidden = true
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
    /** Play was refused for want of a click or key here: ▶ takes the keyboard when the panel gets it. */
    let askFocus = false
    window.addEventListener('focus', () => { if (askFocus) playB.focus({ preventScroll: true }) })

    const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (ep && ep.duration) || 0)
    const now = () => (dragT !== undefined ? dragT : audio.currentTime || 0)
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

    function report(seek) {
      if (!ep) return
      post({ type: 'podcastTime', t: audio.currentTime || 0, playing: playing(), rate: audio.playbackRate, ...(seek ? { seek: true } : {}) })
      scheduleBoundary()
    }
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

    function seek(t) {
      if (!ep) return
      const d = duration()
      const to = Math.max(0, Math.min(d ? d - 0.05 : t, t))
      if (audio.readyState < 1) startAt = to
      else audio.currentTime = to
      draw()
      // Said at once: the journey moves now, not once the audio has the new place buffered.
      post({ type: 'podcastTime', t: to, playing: playing(), rate: audio.playbackRate, seek: true })
      scheduleBoundary()
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
      if (audio.ended) seek(0)
      const p = audio.play()
      if (p && p.catch) p.catch((e) => {
        // VS Code's webviews play audio only after a click or a key in them (once per panel): ▶ takes the keyboard.
        const gesture = e && e.name === 'NotAllowedError'
        showError(gesture ? 'Press Space to play' : `Can't play: ${e && e.message}`)
        if (gesture) { askFocus = true; playB.focus({ preventScroll: true }) }
        post({ type: 'podcastError', message: String(e && (e.name || e.message)) })
      })
    }
    const toggle = () => (playing() ? audio.pause() : play())
    function setRate(r) {
      audio.playbackRate = r
      audio.defaultPlaybackRate = r
    }
    function showError(text) {
      err.textContent = text
      err.hidden = !text
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

    // Space / K play and pause, ← → skip, Shift+← → a step: in the bar, or with nothing else focused (a focused
    // button presses itself; the animation and the map keep their own arrows).
    document.addEventListener('keydown', (e) => {
      if (!ep || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target
      const inBar = root.contains(target)
      const free = target === document.body || target === document.documentElement || !target
      if (!inBar && !free) return
      const onButton = target && target.tagName === 'BUTTON'
      runKey(e, {
        ' ': !onButton && toggle,
        k: toggle,
        ArrowLeft: () => (e.shiftKey ? part(-1) : skip(-SKIP_S)),
        ArrowRight: () => (e.shiftKey ? part(1) : skip(SKIP_S)),
      }, true)
    })

    // ---------- the audio ----------

    audio.addEventListener('loadedmetadata', () => {
      if (startAt) { audio.currentTime = Math.min(startAt, duration()); startAt = 0 }
      build()
      draw()
    })
    audio.addEventListener('timeupdate', () => { if (dragT === undefined) draw(); report(false) })
    audio.addEventListener('play', () => { askFocus = false; showError(''); draw(); tick(); report(false) })
    audio.addEventListener('pause', () => { draw(); report(false) })
    audio.addEventListener('ended', () => { draw(); report(false) })
    audio.addEventListener('ratechange', () => { draw(); report(false) })
    audio.addEventListener('error', () => {
      const e = audio.error
      showError("Can't play the audio")
      post({ type: 'podcastError', message: `audio error ${e ? e.code : '?'}${e && e.message ? `: ${e.message}` : ''}` })
    })

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
      /** The journey's episode (none: the bar goes; the same audio again keeps playing). */
      set(e) {
        if (!e) {
          if (ep) { audio.pause(); audio.removeAttribute('src'); audio.load() }
          ep = undefined
          root.hidden = true
          document.body.classList.remove('has-pod')
          podH = '0px'
          document.documentElement.style.setProperty('--podH', '0px')
          if (opts.onShown) opts.onShown(false)
          return
        }
        const same = ep && ep.src === e.src
        ep = e
        root.hidden = false
        document.body.classList.add('has-pod')
        if (!same) {
          showError('')
          startAt = e.at || 0
          setRate(RATES.includes(e.rate) ? e.rate : 1)
          audio.src = e.src
          audio.load()
        }
        build()
        draw()
        if (opts.onShown) opts.onShown(true)
      },
      cmd(m) {
        if (!ep) return
        const actions = {
          play, toggle,
          pause: () => audio.pause(),
          skip: () => skip(Number(m.by) || 0),
          seek: () => seek(Number(m.to) || 0),
          part: () => part(m.dir < 0 ? -1 : 1),
          rate: () => setRate(Number(m.rate) || 1),
        }
        if (Object.hasOwn(actions, m.action)) actions[m.action]()
      },
      /** For tests: the audio's state. */
      get state() { return { t: audio.currentTime, playing: playing(), paused: audio.paused, ready: audio.readyState, duration: duration(), error: err.hidden ? '' : err.textContent } },
      get shown() { return !!ep },
      /** The journey's titles changed (another journey of the same id, a rename): the tip and labels follow. */
      redraw() { if (ep) draw() },
    }
  }
})()
