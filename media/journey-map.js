// The journey panel (a webview). Plain DOM + SVG. Needs common.js, ELK,
// journey-layout.js, journey-graph.js, journey-scene.js, journey-home.js, journey-splitter.js and journey-tutorial.js,
// loaded before it.
// Layout: "‹ Journeys" (home: every journey, one click walks it), the question, one provenance line, then the
// storyline with the map beside it (wide) or above it (narrow, collapsible under "Map"). The map is the whole journey
// at once (journey-graph.js): pan, zoom, it follows the step; boxes open their code, step numbers walk to the step.
//
// In (handled under "messages from the extension"):
//   { type: 'journey', journey, ...tour }   a journey to show, and where its walk is
//   { type: 'tour', ...tour }               where the walk is now
//     tour = { current, marks, resume, legendHidden, problems, key, list (home), home (its model), tutorial (offer the
//     bar), mapWidth, done, authors, asked, stops, prov? ({ text, tip, changed }), card? (a step with no code to open:
//     { n, lead, details?, refs, stale, staleText?, open }) }
//   { type: 'home' }                        the journey list in front
//   { type: 'preview', key, journey, stale } a journey for the home's preview
//   { type: 'deleted', file }               the journey's file is gone
//   { type: 'tutorial' }                    replay the tutorial
//   { type: 'anim', action: 'toggle' | 'off' } (Ctrl+' P: the current step's animation on/off, as its row's toggle does)
//   { type: 'code', n, i, code }            the lines of beat i of step n's animation
//   { type: 'hello' }                       answered with ready (the extension lost it)
//   { type: 'test', click?: selector, key?: key } (integration tests drive the real handlers)
//   { type: 'podcast', episode? }  { type: 'podcastState', … }  { type: 'podcastRole', … }  { type: 'podcastCmd', … }
//                                          the listening player's (journey-podcast.js: a remote of the Listen view's
//                                          audio, or the host itself after a ▶ here)
//   { type: 'podcastBeat', n, i, still? }  the podcast is on step n's beat i (-1: the step without its animation): the
//                                          animation shows it (still: no flight, it was a jump)
// Out:
//   { type: 'ready' }  { type: 'error', message }
//   { type: 'step', n }  { type: 'end' }  { type: 'finish' }  { type: 'nextStop' } (a check's tour: Next)
//   { type: 'rendered', boxes }  { type: 'story', steps, stops, cur, overflow, width } (what is drawn, for tests)
//   { type: 'legend', hidden }  { type: 'view', node } (the box the map centred on)  { type: 'openPath', path }
//   { type: 'mapWidth', w }  { type: 'panelWidth', w }
//   { type: 'home', on }  { type: 'walk', key }  { type: 'list', query, kind, area, sort?, searchSort? }
//   { type: 'preview', key }  { type: 'refresh', key }  { type: 'hereAll' }
//   { type: 'tutorial', action: 'bar' | 'card' | 'skip' | 'done', card?, editor? }
//   { type: 'ref', i } (a link in the step card)  { type: 'ask', update? }  { type: 'details', open }
//   { type: 'question', id }  { type: 'checkpoint', id }  { type: 'openFile' }  { type: 'restore' }  { type: 'authors' }
//   { type: 'beat', n, i, user? } (the animation's beat on step n; i = -1: the scene is gone; user: the reader moved it)
//   { type: 'podcastAsk', of, action, … }  { type: 'podcastWhy' }  { type: 'podcastEnd', of, action }
//   { type: 'podcastUnlocked' }  and, as the host, podcastTime / podcastState / podcastError / podcastMeta (journey-podcast.js)
//   These are src/journeys/mapPanel.ts MapMessage (the extension's list, with `close` and `pick`, which it handles but
//   nothing here posts, and its own `closed`): a name added here goes there too.
;(function () {
  const { el, button, connect, onMessages, runKey, overflowing, QSTATE } = window.common
  const { vscode, post } = connect()
  const app = document.getElementById('app')

  // ---------- state: everything the panel keeps between renders (render() draws from it) ----------

  /** The walk as the last tour message said it (tour()), drawn from until the next one. */
  const tourOf = (m, cur) => ({
    /** The walk was just finished: Done, the summary. */
    done: !!m.done,
    /** step number -> 'stale' */
    marks: m.marks || {},
    /** Rule breaks only the author can fix (a link to the Output panel). */
    authors: m.authors || 0,
    /** Why the journey can't be read, for readers. */
    problems: m.problems || [],
    /** The step card, when it lives here ("panel"); undefined: it is in the editor. */
    card: m.card && cur ? m.card : undefined,
    /** Steps asked about: n -> { id, count, unread }. */
    asked: m.asked || {},
    /** A check's tour: its questions, each after the step that shows its answer ({ id, n, step, text, state, cur }). */
    stops: m.stops || [],
    /** Who wrote it and when; steps whose code changed since: { text, tip, changed }. */
    prov: m.prov,
  })
  const saved = vscode.getState() || {}

  // The journey and the walk.
  /** @type {any} The journey shown. */
  let J
  /** The current step (0: not walking). */
  let cur = 0
  let T = tourOf({}, 0)
  /** The journey's file is gone: its name ('' while it is there). */
  let deleted = ''
  /** The keys' prefix (Ctrl+' …), as the extension binds them. */
  let KEY = "Ctrl+'"

  // The panel.
  let legendHidden = false
  /** Narrow panels: the map above the storyline, folded away under "Map" by hand (shown by default). */
  let mapShut = !!saved.mapShut
  /** The map column's width when wide, dragged on the splitter; 0: the default. Kept here and by the extension. */
  let mapW = saved.mapW || 0
  /** The next render starts at the top. */
  let toTop = false
  /** The scroll to restore once after a reload (the first render). */
  let savedScroll = saved.scroll || 0
  let firstRender = true
  /** What the last scroll followed ("step|question"): the storyline scrolls to the current row once per change. */
  let scrolled = ''

  // The step's animation.
  /** The step's animation is shown in place of the map: a toggle on the rows of steps that have one. */
  let animOn = !!saved.animOn
  /** The scene on screen ("journey|step"), so the editor's highlight is cleared when it goes. */
  let sceneKey = ''
  /** The beat each step's animation was on, during this walk: next step and back returns to it. */
  let beatAt = {}
  /** The next render puts the keyboard focus in the scene (it was started: ← → work at once). */
  let focusScene = false
  /** Scenes ("journey|step") the podcast jumped to: shown at their beat without its flight. */
  const stillAt = {}

  // Waiting (startup, at the end): the size last rendered ({ w, h }) and the frame a re-layout waits for; the scroll
  // saved and the panel's width reported once things settle.
  let renderedSize
  let relayoutFrame = 0
  let scrollTimer = 0
  let widthTimer = 0
  /** The scroll is saved, and the panel's width reported, once it has not changed for this long (ms). */
  const SCROLL_SAVE_MS = 300, WIDTH_REPORT_MS = 500

  function saveState() {
    const n = J ? J.steps.length : 0
    vscode.setState({ id: J && J.id, q: J && J.question, cur, n, scroll: window.scrollY, mapShut, mapW, animOn, trOn, podSession })
  }
  /** Step `n`'s animation, when it has one with beats. */
  function sceneOf(n) {
    const s = J && J.steps[n - 1]
    const ok = s && s.scene && Array.isArray(s.scene.beats) && s.scene.beats.length
    return ok ? s.scene : undefined
  }

  // ---------- markdown: the little a journey's text uses, as HTML (escaped first, then marked up) ----------

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  /** Enough markdown for summaries: `code` and **bold**. */
  const md = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>') // `code`
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>') // **bold**
  /** A line of step text: md, links (posted back by the step card's click handler) and ~~gone~~. */
  const inline = (t) => md(t)
    .replace(/\[([^\]]+)\]\(ref:(\d+)\)/g, '<button class="ref link" data-i="$2">$1</button>') // [text](ref:i): code
    .replace(/\[([^\]]+)\]\(note:([\w.-]+)\)/g, '<button class="noteq link" data-id="$2">$1</button>') // a question
    .replace(/\[([^\]]+)\]\(ask:update\)/g, '<button class="askupd link">$1</button>') // ask for the step's update
    .replace(/~~([^~]+)~~/g, '<s>$1</s>') // ~~gone~~
  /** A fenced block's lines; a diff's (a stale step's) coloured: - deleted, + inserted. */
  const fence = (lang, body) => {
    const cls = (l) => (lang === 'diff' && /^[-+]/.test(l) ? (l[0] === '-' ? 'del' : 'ins') : '')
    return `<pre class="code">${body.split('\n').map((l) => `<span class="${cls(l)}">${esc(l)}</span>`).join('\n')}</pre>`
  }
  /** Step text: inline markup, fenced blocks, paragraphs, "- " lists, ---. */
  function mdBlock(s) {
    // The fenced blocks first, each left as a placeholder line (\u0000n\u0000) the paragraphs don't split.
    const fences = []
    s = s.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_m, lang, body) => { fences.push(fence(lang, body)); return `\u0000${fences.length - 1}\u0000` })
    return s.split(/\n{2,}/).map((p) => {
      const f = /^\u0000(\d+)\u0000$/.exec(p.trim())
      if (f) return fences[Number(f[1])]
      if (/^\s*---\s*$/.test(p)) return '<hr>'
      const ls = p.split('\n')
      if (ls.every((l) => /^\s*[-*] /.test(l))) return `<ul>${ls.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
      return `<p>${ls.map(inline).join('<br>')}</p>`
    }).join('')
  }
  const markOf = (n) => T.marks[n] || ''

  // ---------- messages from the extension (In: above), one handler each ----------

  onMessages({
    journey(m) {
      const fresh = !J || J.id !== m.journey.id
      // Another journey starts at the top, its map in view: never the last one's scroll.
      if (fresh) {
        if (J) { savedScroll = 0; toTop = true }
        scrolled = ''
        beatAt = {}
        setHome(false)
      }
      J = m.journey
      deleted = ''
      tour(m)
      render()
    },
    tour(m) { tour(m); render() },
    home() { tutorial.close(); setHome(true); render() },
    hello() { post({ type: 'ready' }) },
    preview(m) { home.preview(m) },
    deleted(m) { deleted = m.file || 'the file'; tutorial.close(); tutorial.hideOffer(); render() },
    tutorial() { tutorial.start() },
    // Ctrl+' P toggles the current step's animation; 'off' ends it.
    anim(m) {
      if (m.action === 'toggle') toggleAnim()
      else if (m.action === 'off' && animOn) toggleAnim()
    },
    // The current beat's line and the lines around it, once the extension found them.
    code(m) { if (scene && animOn && m.n === cur && m.i === scene.beat) scene.code(m.code) },
    podcast(m) { if (podcast) { podcast.set(m.episode); render() } },
    podcastState(m) { if (podcast) podcast.hostState(m) },
    podcastRole(m) { if (podcast) podcast.setRole(m) },
    podcastCmd(m) { if (podcast) podcast.cmd(m) },
    podcastBeat(m) { podcastBeat(m) },
    test(m) {
      if (m.click) {
        const t = document.querySelector(m.click)
        if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
      if (m.key) document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true }))
    },
  })

  /** A tour message: where the walk is, and what that resets. */
  function tour(m) {
    // Never past the last step (the step you were on was removed).
    const N = J ? J.steps.length : 0
    const was = cur
    cur = Math.min(m.current || 0, N)
    const moved = !!cur && cur !== was
    // A step opened (D, a click in the code): the journey, not the list. The walk ended: back to the top.
    if (moved) setHome(false)
    if (!cur && was) { toTop = true; scrolled = ''; beatAt = {}; animOn = false }
    T = tourOf(m, cur)
    legendHidden = !!m.legendHidden
    if (!splitter.dragging) mapW = m.mapWidth || 0
    if (m.key) KEY = m.key
    home.take(m)
    // The "New here?" bar: offered, or gone once the walk is under way.
    tutorial.onTour(!!m.tutorial, moved)
  }

  function goStep(n) {
    // The tutorial is a sandbox: a step clicked under it moves the tutorial on, not your place in the journey.
    if (tutorial.card) return
    if (!deleted && n >= 1 && n <= J.steps.length) post({ type: 'step', n })
  }

  // ---------- header (sticky: question, breadcrumb, where the step is: R7) ----------

  function header() {
    const h = el('header')
    const top = el('div', 'top')
    // An episode on (playing or paused): one line that names where the voice is ("Step 6 of 14 · title", "Intro");
    // ‹ and End only on pause. The question and the byline come back once the episode is over.
    if (inEpisode() && !deleted) {
      h.classList.add('listening')
      if (!listening) {
        const hb = el('button', 'link homeb', '‹')
        hb.title = 'All journeys'
        hb.setAttribute('aria-label', 'All journeys')
        hb.onclick = goHome
        top.append(hb)
      }
      const q = el('h1', 'q', listeningTitle())
      q.title = listeningTitle()
      top.append(q, ...(listening ? [] : [stepControls()]))
      h.append(top)
      return h
    }
    // The short title, as in the lists and the tab; the question under it.
    const q = el('h1', 'q', J.title || J.question)
    const hb = el('button', 'link homeb', '‹ Journeys')
    hb.title = 'All journeys'
    hb.onclick = goHome
    h.append(hb)
    top.append(q, stepControls())
    h.append(top)
    if (J.title && J.question && J.question.toLowerCase() !== J.title.toLowerCase()) {
      const sq = el('p', 'qsub', J.question)
      sq.title = J.question
      h.append(sq)
    }
    if (deleted) {
      // "Deleted · Restore": the tab closes like any tab, the picker is a command.
      const g = el('p', 'gone', 'Deleted')
      const r = button('link restore', 'Restore', () => post({ type: 'restore' }))
      g.append(el('span', 'sep', ' · '), r)
      h.append(g)
      return h
    }
    // No summary under the question: the storyline is the answer; the summary is in the picker.
    // One muted line: who wrote it, when; amber when steps are out of date. Nothing else.
    const prov = T.prov
    if (prov && (prov.text || prov.changed)) {
      const p = el('p', 'prov', prov.text || '')
      if (prov.tip) p.title = prov.tip
      // "out of date", not "changed since" (since what?); the tooltip says what happened.
      if (prov.changed) {
        const steps = `${prov.changed} step${prov.changed === 1 ? '' : 's'}`
        const c = el('span', 'changed', `${prov.text ? ' · ' : ''}⚠ ${steps} out of date`)
        c.title = 'The code changed after this journey was written'
        p.append(c)
      }
      h.append(p)
    }
    if (T.problems.length) h.append(problemLine())
    return h
  }

  /** While listening: the step the voice is on ("Step 6 of 14 · title"), or the part on the map ("Intro", "Recap"). */
  function listeningTitle() {
    if (cur) return `Step ${cur} of ${J.steps.length} · ${J.steps[cur - 1].title}`
    const ep = podcast && podcast.episode
    const t = podcast ? podcast.now.t : 0
    const cs = ep ? ep.chapters : []
    let i = 0
    for (let k = 0; k < cs.length; k++) if (t >= cs[k].start) i = k
    return i === 0 ? 'Intro' : i === cs.length - 1 ? 'Recap' : 'Map'
  }

  /** One short line when the journey can't be read (readers see only what affects reading); the list on hover. */
  function problemLine() {
    const d = el('div', 'problems')
    const b = el('span', 'plink', `⚠ ${T.problems[0]} `)
    b.title = T.problems.join('\n')
    const o = el('button', 'link openfile', 'Open file')
    o.onclick = () => post({ type: 'openFile' })
    d.append(b, o)
    return d
  }
  /** Rule breaks only the author can fix: a quiet link to the Output channel. */
  function authorLink() {
    const a = el('button', 'link authors', `${T.authors} rule break${T.authors === 1 ? '' : 's'}`)
    a.title = 'In the Output panel'
    a.onclick = () => post({ type: 'authors' })
    return a
  }

  function stepControls() {
    const t = el('div', 'tour')
    if (!J.steps.length || deleted) return t
    // No Start or Resume: opening a journey walks it; after End, a step in the storyline (or D)
    // walks on, and the storyline marks where it was left.
    if (!cur) return t
    // The position is on the card and the status bar; ‹ › on the card; the keys work everywhere.
    // It says what it closes (R2).
    // One control to end: on the last step the card's Finish is it.
    if (cur === J.steps.length) return t
    const end = el('button', 'tbtn end', 'End')
    end.title = 'Stop walking this journey'
    end.onclick = () => { podSession = ''; post({ type: 'end' }) }
    t.append(end)
    return t
  }

  // ---------- storyline: the step titles; the current one expanded when the card lives here ----------

  function storyline() {
    const { stops, card } = T
    const ol = el('ol', 'story')
    ol.setAttribute('aria-label', 'Steps')
    // With a podcast the storyline is its chapter list: number and title, the row being said in bold, ▶ (on hover) to
    // hear just that step; the transcript of the row being said under it (the Transcript switch, transcriptHead()).
    const chap = podcastChapters()
    if (chap) ol.classList.add('pod-story')
    if (chap && chap.intro) ol.append(partRow(chap.intro, 'Intro'))
    // Every step, always (no folded "n steps elsewhere").
    for (const s of J.steps) {
      const li = el('li')
      // It leads: every row is plain; only the current one and a stale one (its number amber:) stand out. No
      // mark where you stopped (after End nothing looks half on; the list says n/N).
      // At a question after this step: the question's row is the current one.
      const here = s.n === cur && !stops.some((q) => q.cur)
      const b = el('button', ['st', here ? 'cur' : '', markOf(s.n)].filter(Boolean).join(' '))
      b.dataset.n = s.n
      // Number and title only: no "later", no question marks (they are in the step card), no "stopped
      // here" (the quiet mark says it).
      b.append(el('span', 'n', String(s.n)), el('span', 't', s.title))
      if (markOf(s.n)) b.title = 'The code changed since this step was written'
      if (here) b.setAttribute('aria-current', 'step')
      b.onclick = () => goStep(s.n)
      if (chap) {
        const c = chap.steps.get(s.n)
        const row = el('div', 'strow')
        row.append(b)
        if (!c) { li.classList.add('unnarrated'); b.title = b.title || "The podcast doesn't talk about this step: it pauses here" }
        else row.append(stepListen(s.n))
        li.dataset.pstep = String(s.n)
        li.append(row)
        if (c) li.append(transcript(`s${s.n}`, c.segs))
      } else li.append(b)
      // The animation's toggle, on the current row only and in words (a ▶ on every row read as "run the test");
      // while it plays the scene beside the row is the state, and its Map (or Esc) ends it.
      if (scene && s.n === cur && sceneOf(s.n) && !(animOn && !tutorial.card)) {
        const a = el('button', 'animbtn', 'Show animation')
        a.title = `Play this step as an animation (${KEY} P)`
        a.onclick = () => toggleAnim()
        li.append(a)
      }
      // A step with no code to open (file or code gone:) shows its card here, in place of the editor jump.
      if (s.n === cur && card) li.append(stepCard())
      ol.append(li)
      for (const q of stops.filter((x) => x.step === s.n)) ol.append(stopRow(q))
      for (const m of (chap && chap.after.get(s.n)) || []) ol.append(partRow(m, 'Map'))
    }
    if (chap && chap.recap) ol.append(partRow(chap.recap, 'Recap'))
    return ol
  }

  // ---------- the storyline as the podcast's chapter list (journey-podcast.js has the episode) ----------

  /** The Transcript switch: the transcript of the row being said shows under it (across re-renders). */
  let trOn = !!saved.trOn
  /** The row the voice is on ('intro', 's3', 'map5', 'recap'): its transcript is the one shown. */
  let trRow = ''
  /** The episode's parts by step: { steps: n -> { start, end, segs }, intro, recap, after: n -> [map parts] }. */
  function podcastChapters() {
    const ep = podcast && podcast.episode
    if (!ep || !ep.chapters.length) return undefined
    const steps = new Map(), after = new Map()
    let intro, recap, lastStep = 0
    const cs = ep.chapters
    for (const [i, c] of cs.entries()) {
      const segs = ep.segments.filter((x) => x.start >= c.start - 0.001 && x.start < c.end - 0.001)
      if (c.step) {
        const had = steps.get(c.step)
        if (had) { had.end = c.end; had.segs.push(...segs) } else steps.set(c.step, { start: c.start, end: c.end, segs })
        lastStep = c.step
      } else if (i === 0) intro = { start: c.start, end: c.end, segs, key: 'intro' }
      else if (i === cs.length - 1) recap = { start: c.start, end: c.end, segs, key: 'recap' }
      else after.set(lastStep, [...(after.get(lastStep) || []), { start: c.start, end: c.end, segs, key: `map${i}` }])
    }
    return { steps, intro, recap, after }
  }
  /** A part on the map (the intro, the recap) as a row like the others (no number): its name, its transcript. */
  function partRow(c, name) {
    const li = el('li', 'ppart')
    const row = el('div', 'strow')
    const b = el('button', 'st part')
    b.append(el('span', 'n', ''), el('span', 't', name))
    b.title = `Listen from the ${name.toLowerCase()}`
    b.onclick = () => podcast.playFrom(c.start)
    li.dataset.ppart = c.key
    row.append(b)
    li.append(row, transcript(c.key, c.segs))
    return li
  }
  /** ▶ on a row: that step alone, stopping at its end. */
  function stepListen(n) {
    const label = `Listen to step ${n} only`
    const b = el('button', 'icon plisten', '▶')
    b.title = label
    b.setAttribute('aria-label', label)
    b.onclick = () => podcast.playStep(n)
    return b
  }
  /** "Transcript" above the chapter list: the transcript of the row being said, under it, following the voice. */
  function transcriptHead() {
    const d = el('div', 'trhead')
    const b = el('button', 'link trtoggle', 'Transcript')
    b.setAttribute('aria-pressed', String(trOn))
    b.onclick = () => {
      trOn = !trOn
      b.setAttribute('aria-pressed', String(trOn))
      showTranscripts()
      saveState()
    }
    d.append(b)
    return d
  }
  /** The row being said's transcript shown (Transcript on), the others shut. */
  function showTranscripts() {
    for (const t of app.querySelectorAll('.trx')) setTrOpen(t, trOn && t.dataset.tr === trRow)
  }
  /** Shut transcripts stay findable (Ctrl+F opens the one with the match: hidden="until-found"). */
  function setTrOpen(t, open) {
    if (open) t.removeAttribute('hidden')
    else t.setAttribute('hidden', 'until-found')
  }
  /** A row's transcript: its sentences, the one being said marked; a click goes there. */
  function transcript(key, segs) {
    const d = el('div', 'trx')
    d.dataset.tr = key
    setTrOpen(d, trOn && key === trRow)
    const ep = podcast.episode
    const many = new Set(ep.segments.map((x) => x.speaker).filter(Boolean)).size > 1
    let prevWho = ''
    for (const seg of segs) {
      const p = el('p', 'trp')
      if (many && seg.speaker && seg.speaker !== prevWho) p.append(el('b', 'trw', `${seg.speaker[0].toUpperCase()}${seg.speaker.slice(1)}: `))
      prevWho = seg.speaker || prevWho
      for (const sen of podcast.sentencesOf(seg)) {
        const x = el('span', 'trs', sen.text)
        x.dataset.t = String(sen.start)
        x.dataset.e = String(sen.end)
        x.tabIndex = -1
        x.onclick = () => podcast.seek(sen.start)
        p.append(x, ' ')
      }
      d.append(p)
    }
    return d
  }
  /** The podcast's time moved: ♪ on the row being said, the sentence being said marked (only when they change). */
  let lastTick = ''
  function onPodcastTick(t, step, playing) {
    const ep = podcast && podcast.episode
    if (!ep) return
    let i = 0
    for (let k = 0; k < ep.chapters.length; k++) if (t >= ep.chapters[k].start) i = k
    const c = ep.chapters[i]
    const rowKey = c && c.step ? `s${c.step}` : c ? (i === 0 ? 'intro' : i === ep.chapters.length - 1 ? 'recap' : `map${i}`) : ''
    let sen
    for (const x of app.querySelectorAll(`.trx[data-tr="${rowKey}"] .trs`)) if (t >= Number(x.dataset.t) - 0.01) sen = x
    const k = `${rowKey}|${sen ? sen.dataset.t : ''}|${playing}`
    if (k === lastTick) return
    lastTick = k
    if (rowKey !== trRow) { trRow = rowKey; showTranscripts() }
    for (const r of app.querySelectorAll('.story .pnow')) r.classList.remove('pnow')
    const row = app.querySelector(c && c.step ? `.story li[data-pstep="${c.step}"]` : `.story li[data-ppart="${rowKey}"]`)
    if (row) row.classList.add('pnow')
    for (const x of app.querySelectorAll('.trs.cur')) x.classList.remove('cur')
    if (sen) sen.classList.add('cur')
  }

  /** A check's question as a row of the storyline, after the step that shows its answer: "? Why …", its state
   *  (common.js QSTATE: the icon here is `storyIcon` when it has one). */
  function stopRow(q) {
    const li = el('li', 'cpl')
    const b = el('button', ['cp', q.state, q.cur ? 'cur' : ''].filter(Boolean).join(' '))
    b.dataset.q = q.id
    const st = Object.hasOwn(QSTATE, q.state) ? QSTATE[q.state] : {}
    const icon = el('span', 'n', st.storyIcon || st.icon || '?')
    icon.setAttribute('aria-hidden', 'true')
    const t = el('span', 't', q.text)
    b.append(icon, t)
    if (st.word) b.append(el('span', 'w', st.word))
    b.title = `Question ${q.n}: ${q.text}`
    b.setAttribute('aria-label', `Question ${q.n}${st.answered ? ', answered' : ''}: ${q.text}`)
    if (q.cur) b.setAttribute('aria-current', 'step')
    b.onclick = () => { if (!tutorial.card && !deleted) post({ type: 'checkpoint', id: q.id }) }
    li.append(b)
    return li
  }

  /** The step card in the panel: lead, More, refs, ‹ ›, Ask. Links are posted back by index. */
  function stepCard() {
    const { card } = T
    const c = el('div', 'scard')
    c.setAttribute('role', 'region')
    c.setAttribute('aria-label', `Step ${cur}`)
    const text = (cls, s) => { const d = el('div', cls); d.innerHTML = mdBlock(s); c.append(d) }
    if (card.staleText) text('sstale', card.staleText)
    if (card.lead) text('slead', card.lead)
    c.append(stepNav(card))
    if (card.open && card.details) text('sdetails', card.details)
    if (card.open && card.refs) text('srefs', card.refs)
    // A notice last, quiet.
    if (card.notice) c.append(el('div', 'snotice', `ℹ ${card.notice}`))
    // A reference reads as its file name; the whole path on hover.
    for (const r of c.querySelectorAll('.ref')) { const t = (card.paths || [])[Number(r.dataset.i)]; if (t) r.title = t }
    // The links in its text (mdBlock's buttons).
    c.addEventListener('click', (e) => {
      const r = e.target.closest('.ref')
      if (r) { e.stopPropagation(); post({ type: 'ref', i: Number(r.dataset.i) }) }
      if (e.target.closest('.askupd')) { e.stopPropagation(); post({ type: 'ask', update: true }) }
      const nq = e.target.closest('.noteq')
      if (nq) { e.stopPropagation(); post({ type: 'question', id: nq.dataset.id }) }
    })
    return c
  }

  /** The step card's links: ‹ Previous, Next › (or Finish), the step's questions, Ask, More / Less. */
  function stepNav(card) {
    const { stops, asked } = T
    const last = cur === J.steps.length
    const nav = el('div', 'snav')
    if (cur > 1) nav.append(button('link sprev', '‹ Previous', () => goStep(cur - 1)))
    // A check's tour: Next goes through the extension, which stops at the questions between the steps.
    if (stops.length) nav.append(button('link snext', last ? 'Finish' : 'Next ›', () => post({ type: 'nextStop' })))
    else if (!last) nav.append(button('link snext', 'Next ›', () => goStep(cur + 1)))
    else nav.append(button('link send', 'Finish', () => post({ type: 'finish' })))
    // The step's questions live here only: a count, the unread colour for a new reply.
    const a = asked[cur]
    if (a) nav.append(button(`link squestion${a.unread ? ' unread' : ''}`, `${a.count || 1} asked ›`, () => post({ type: 'question', id: a.id })))
    // One Ask in a stale card: the banner's, which opens the request prefilled.
    if (!card.staleText) nav.append(button('link sask', 'Ask', () => post({ type: 'ask' })))
    // More holds the details and the references (no bare link row).
    if (card.details || card.refs) nav.append(button('link smore', card.open ? 'Less' : 'More', () => post({ type: 'details', open: !card.open })))
    return nav
  }

  // ---------- the map: the whole journey at once, panned and zoomed (journey-graph.js) ----------

  const graph = window.JourneyGraph({
    goStep,
    open: (path) => post({ type: 'openPath', path }),
    isTutorialUp: () => !!tutorial.card,
    legend: (hidden) => { legendHidden = hidden; post({ type: 'legend', hidden }) },
    rendered: (boxes) => post({ type: 'rendered', boxes }),
    view: (node) => post({ type: 'view', node }),
    error: (message) => post({ type: 'error', message }),
  })

  /** The animation player: one, kept across renders (its beat and its transitions survive them). */
  const scene = window.JourneyScene ? window.JourneyScene.create({
    // `user`: moved by the reader (‹ ›, the keys), not shown with the step nor set by the podcast.
    onBeat: (i, how) => { if (sceneKey) beatAt[sceneKey] = i; post({ type: 'beat', n: cur, i, ...(how === 'go' && !podcastGoing ? { user: true } : {}) }) },
    onClose: () => toggleAnim(),
    // At the last beat › walks on, the animation still on.
    onNextStep: () => { focusScene = true; goStep(cur + 1) },
  }) : undefined
  /** The current step's animation on or off: the row's toggle, the scene's Map and Esc, Ctrl+' P. */
  function toggleAnim() {
    if (!scene || !J || !cur || !sceneOf(cur) || tutorial.card || deleted || home.on) return
    animOn = !animOn
    if (animOn) { focusScene = true; tutorial.dropOffer() }
    render()
    // Off: the keyboard stays on the row's toggle, where it can start it again.
    if (!animOn) app.querySelector('.animbtn')?.focus({ preventScroll: true })
  }
  function sceneEl() {
    const wrap = el('div', 'mapwrap scnwrap')
    wrap.append(scene.el)
    return wrap
  }
  /** Shows the step's scene once it is in the page (a packet only flies in a laid-out scene). */
  function placeScene() {
    const k = `${J.id}|${cur}`
    const fresh = k !== sceneKey
    sceneKey = k
    scene.layout()
    const still = !!stillAt[k]
    delete stillAt[k]
    scene.show(sceneOf(cur), k, { file: J.steps[cur - 1].file, next: cur < J.steps.length, beat: beatAt[k] || 0, still })
    // The podcast moved it: the keyboard stays where it was (Space keeps pausing).
    if ((fresh || focusScene) && !podcastMoved) scene.focus()
    focusScene = false
    podcastMoved = false
  }

  // ---------- the podcast (journey-podcast.js): its bar, and the animation following it ----------

  /** The audio is playing (its host says so): the step's animation (or the map) alone under a one-line header; the
   *  beat's sentence, its bar and the code snippet give way to the caption (one text channel while you listen). On
   *  pause the chapter list comes back. */
  let listening = false
  /** The episode listened to in this panel and not over yet (its key; '' none): the header stays one line, paused
   *  too, until it ends (or End). */
  let podSession = saved.podSession || ''
  /** An episode is on: playing, or paused before its end. */
  function inEpisode() {
    const ep = podcast && podcast.episode
    if (!ep || !J || podcast.now.ended) return false
    return listening || podSession === ep.key
  }
  const podcast = window.JourneyPodcast ? window.JourneyPodcast({
    post,
    mode: 'remote',
    stepTitle: (n) => (J && J.steps[n - 1] ? J.steps[n - 1].title : ''),
    stepCount: () => (J ? J.steps.length : 0),
    keyPrefix: () => KEY,
    onListening: (on) => {
      if (on === listening) return
      listening = on
      const ep = podcast && podcast.episode
      if (on && ep) podSession = ep.key
      else if (!ep || podcast.now.ended) podSession = ''
      document.body.classList.toggle('pod-on', on)
      if (J && !home.on) render()
      else saveState()
    },
    onTick: (t, step, playing) => onPodcastTick(t, step, playing),
  }) : undefined
  /** The next scene shown was put there by the podcast, not by a click; the beat being set is the podcast's. */
  let podcastMoved = false
  let podcastGoing = false
  /**
   * The podcast is on step n, beat i (-1: the step without its animation). Sent before the step opens, so the step
   * comes up on that beat (never its first beat, then a jump); `still`: a seek, the beat is shown without its flight.
   */
  function podcastBeat(m) {
    if (!J || !scene) return
    const k = `${J.id}|${m.n}`
    const on = m.i >= 0 && !!sceneOf(m.n)
    if (on) {
      beatAt[k] = m.i
      if (m.still) stillAt[k] = true
    }
    const was = animOn
    animOn = on
    podcastMoved = true
    if (m.n !== cur) { podcastScroll = true; return } // the tour message that follows draws it
    if (on && was && sceneKey === k) {
      podcastGoing = true
      try { scene.go(m.i, false, !!m.still) } finally { podcastGoing = false }
      delete stillAt[k]
      podcastMoved = false
      return
    }
    if (on !== was) render()
    else podcastMoved = false
  }

  function mapEl() {
    const wrap = el('div', 'mapwrap')
    wrap.append(graph.el)
    if (T.authors && !deleted) { const a = el('div', 'note'); a.append(authorLink()); wrap.append(a) }
    return wrap
  }

  // ---------- home: every journey, to find one and walk it (journey-home.js) ----------

  const home = window.JourneyHome({
    app,
    post,
    render,
    walk: walkKey,
    hasJourney: () => !!J,
    isTutorialUp: () => !!tutorial.card,
  })
  const setHome = (on) => home.set(on)
  function goHome() { if (!tutorial.card) home.open() }
  function walkKey(k) { if (!k) return; setHome(false); toTop = true; post({ type: 'walk', key: k }); render() }

  // ---------- the tutorial: a few cards on the real panel (journey-tutorial.js) ----------

  const tutorial = window.JourneyTutorial({ app, post, render, journey: () => J, isDeleted: () => !!deleted })

  // ---------- the splitter: the map column's width (journey-splitter.js) ----------

  const splitter = window.JourneySplitter(app, { onResize: () => graph.resized(), onKeep: keepWidth })
  /** The width chosen: remembered here and by the extension (every panel, every journey); 0 resets to the default. */
  function keepWidth(w) {
    mapW = w
    saveState()
    post({ type: 'mapWidth', w })
  }

  // ---------- render: the whole panel again from the state ----------

  function render() {
    if (!J) return
    const keepY = beforeRender()
    app.textContent = ''
    app.classList.toggle('deleted', !!deleted)
    if (home.on) { home.draw(); saveState(); return }
    const episode = inEpisode()
    // Playing: the step's animation, or the map, alone (the same box every step); the rest comes back on pause. A panel
    // too narrow for the map's boxes keeps the chapter list (an empty box would be all there is).
    const boxOnly = episode && listening && !deleted && !tutorial.card && window.JourneySplitter.mapFits(app.clientWidth)
    document.body.classList.toggle('pod-map', boxOnly && !cur)
    // No "New here?" while an episode is on (the walk's tutorial is not about listening).
    if (tutorial.offered && !tutorial.card && !deleted && !episode) app.append(tutorial.bar())
    const head = el('div', 'head')
    head.append(header())
    app.append(head)
    if (T.done && !cur && !deleted && !episode) app.append(doneView())
    // The storyline leads: the map beside it (wide) or above it (narrow, foldable under "Map"); too narrow for
    // boxes: none.
    const L = boxOnly ? boxLayout() : chooseLayout()
    const body = el('div', boxOnly ? 'body pbox' : 'body')
    const m = L.shown ? (L.anim ? sceneEl() : mapEl()) : undefined
    // No animation on screen any more: the editor's highlight of its beat goes too.
    if (!(L.shown && L.anim) && sceneKey) { sceneKey = ''; scene.forget(); post({ type: 'beat', n: 0, i: -1 }) }
    if (boxOnly) {
      if (m) body.append(m)
      app.append(body)
      afterRender(body, head, m, L, 0)
      return
    }
    const story = J.steps.length ? storyColumn() : el('p', 'note', 'This journey has no steps yet.')
    if (L.wide) {
      body.classList.add('wide')
      body.classList.toggle('anim', L.anim)
      body.append(story, ...(m ? [splitter.el(body), m] : []))
    } else {
      if (L.hasMap && J.steps.length && !tutorial.card && !L.anim) body.append(mapToggle(L.shown))
      body.append(...(m ? [m] : []), story)
    }
    app.append(body)
    afterRender(body, head, m, L, keepY)
  }

  /** Before the panel is emptied: the keyboard and the scroll it keeps. Returns the scroll to go back to (0: none). */
  function beforeRender() {
    // The home's search keeps the keyboard across a re-render (the list is drawn again under it); so do a row, a chip.
    home.beforeRender()
    // The scene keeps the keyboard across a re-render (its element is taken out and put back).
    if (scene && scene.el.contains(document.activeElement)) focusScene = true
    // A re-render keeps the scroll; the first render after a reload goes back to where it was.
    const keepY = toTop ? 0 : firstRender ? savedScroll : window.scrollY
    if (toTop) window.scrollTo(0, 0)
    toTop = false
    firstRender = false
    return keepY
  }

  /** What goes where at this panel's width: { wide: the map beside the storyline (else above it), hasMap: room for
   *  boxes, anim: the step's animation in place of the map, shown: the map (or the animation) is on screen }. */
  function chooseLayout() {
    const tutorialUp = !!tutorial.card
    // The step's animation is on (and nothing else is in front).
    const animOnStep = !!scene && animOn && !!cur && !!sceneOf(cur) && !tutorialUp && !deleted
    // Beside the storyline when both fit (journey-splitter.js has the widths); else above it.
    const wide = window.JourneySplitter.besideFits(app.clientWidth, animOnStep)
    const tooNarrow = !window.JourneySplitter.mapFits(app.clientWidth) && !tutorialUp
    const hasMap = !tooNarrow
    const anim = animOnStep && hasMap
    // Narrow: folded under "Map" by hand, but never while the tutorial points at it, with no steps, or animating.
    const shown = hasMap && (wide || !mapShut || tutorialUp || !J.steps.length || anim)
    return { wide, hasMap, anim, shown }
  }

  /** Playing: the box alone, the animation when the step has one on, else the map. */
  function boxLayout() {
    const hasMap = window.JourneySplitter.mapFits(app.clientWidth)
    const anim = hasMap && !!scene && animOn && !!cur && !!sceneOf(cur)
    return { wide: false, hasMap, anim, shown: hasMap }
  }

  /** The storyline, under "Transcript" when it is the podcast's chapter list. */
  function storyColumn() {
    const ol = storyline()
    if (!ol.classList.contains('pod-story')) return ol
    const d = el('div', 'storycol')
    d.append(transcriptHead(), ol)
    return d
  }

  /** Narrow panels: "Map", which folds the map away (or back). */
  function mapToggle(shown) {
    const t = el('button', 'link maptoggle', 'Map')
    t.setAttribute('aria-expanded', String(shown))
    t.title = shown ? 'Hide the map' : 'Show the map'
    t.onclick = () => { mapShut = !mapShut; render() }
    return t
  }

  /** Once the panel is in the page: the map column's width, the header's height, the map (or the scene) placed, the
   *  scroll back, the current row in view, the reports, the tutorial. */
  function afterRender(body, head, m, L, keepY) {
    if (L.wide && m) splitter.widthTo(body, mapW)
    const headH = head.offsetHeight
    document.documentElement.style.setProperty('--headH', `${headH}px`)
    graph.set(J, cur, legendHidden)
    if (m && !L.anim) graph.placed()
    if (m && L.anim) placeScene()
    if (keepY) window.scrollTo(0, keepY)
    savedScroll = 0
    follow()
    // Where the voice is, marked at once on the rows just drawn (not only at the next tick).
    lastTick = ''
    if (podcast && podcast.episode) { const nw = podcast.now; onPodcastTick(nw.t, -1, nw.playing) }
    if (podcastScroll) { podcastScroll = false; scrollToStep(L) }
    reportStory()
    saveState()
    tutorial.place()
  }

  /** What the storyline shows (for tests): its rows, the questions between them, anything cut or wider than the panel. */
  function reportStory() {
    requestAnimationFrame(() => {
      const overflow = overflowing(app, '.story .st, .story .cp, .story .t', (e) => e.textContent.slice(0, 40))
      post({
        type: 'story',
        steps: app.querySelectorAll('.story .st').length,
        stops: [...app.querySelectorAll('.story .cp')].map((b) => b.dataset.q),
        cur: (app.querySelector('.story .cp.cur') || {}).dataset?.q,
        overflow,
        width: document.documentElement.clientWidth,
      })
    })
  }

  /** The walk finished: one line and the summary (two sentences at most). */
  function doneView() {
    const d = el('div', 'done')
    d.setAttribute('role', 'status')
    d.append(el('p', 'dtitle', 'Done'))
    const sum = (J.summary || '').match(/[^.!?]+[.!?]+(\s|$)/g)
    const two = sum ? sum.slice(0, 2).join('').trim() : (J.summary || '').trim()
    if (two) { const p = el('p', 'dsum'); p.innerHTML = md(two); d.append(p) }
    // The way to the others is the header's "‹ Journeys", right above (not a second one here).
    return d
  }

  /** Once per step change: the current storyline row in view under the sticky header (the map follows on its own). */
  function follow() {
    if (tutorial.card) return
    const at = T.stops.find((q) => q.cur)
    const k = `${cur}|${at ? at.id : ''}`
    if (!cur || k === scrolled) return
    scrolled = k
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--headH')) || 0
    const row = app.querySelector('.story .st.cur, .story .cp.cur')
    if (row) scrollRowIntoView(row.getBoundingClientRect(), top)
  }

  /** The voice moved to another step: the step's top in view (its animation, narrow; its row, wide) unless the reader
   *  scrolled in the last moments. */
  let podcastScroll = false
  let readerScrolled = 0
  const READER_SCROLL_MS = 2000
  for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, () => { readerScrolled = Date.now() }, { passive: true })
  function scrollToStep(L) {
    if (Date.now() - readerScrolled < READER_SCROLL_MS || !cur) return
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--headH')) || 0
    const target = !L.wide && L.shown ? app.querySelector('.body > .mapwrap') : app.querySelector('.story .st.cur')
    if (!target) return
    window.scrollBy(0, target.getBoundingClientRect().top - top - ROW_TOP_GAP)
  }

  /** A row closer than this (px) to the sticky header or the window's bottom is scrolled into view. */
  const ROW_MARGIN = 4
  /** Where a row scrolled into view lands: this far (px) under the header, or above the window's bottom. */
  const ROW_TOP_GAP = 12, ROW_BOTTOM_GAP = 16
  /** Scrolls the page so row rectangle `r` (viewport px) is in view under the header (its bottom at `top`): at the
   *  top when it was above or is taller than the room, else just up from the bottom. */
  function scrollRowIntoView(r, top) {
    // The podcast bar covers the bottom of the window.
    const H = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--podH')) || 0)
    const above = r.top < top + ROW_MARGIN
    if (!above && r.bottom <= H - ROW_MARGIN) return
    const atTop = above || r.height > H - top
    window.scrollBy(0, atTop ? r.top - top - ROW_TOP_GAP : r.bottom - H + ROW_BOTTOM_GAP)
  }

  // ---------- startup ----------

  // Re-lay out when the size changes, a frame later (rendering inside the observer would loop it).
  const relayout = () => {
    cancelAnimationFrame(relayoutFrame)
    relayoutFrame = requestAnimationFrame(() => {
      const size = { w: app.clientWidth, h: window.innerHeight }
      const same = !!renderedSize && renderedSize.w === size.w && renderedSize.h === size.h
      if (J && !same) { renderedSize = size; render() }
    })
  }
  // The panel's width as the reader drags it: the extension keeps it for the next walk.
  const reportWidth = () => {
    clearTimeout(widthTimer)
    widthTimer = setTimeout(() => post({ type: 'panelWidth', w: window.innerWidth }), WIDTH_REPORT_MS)
  }
  new ResizeObserver(relayout).observe(app)
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => { if (J) saveState() }, SCROLL_SAVE_MS)
  })
  window.addEventListener('resize', () => { relayout(); reportWidth() })
  post({ type: 'ready' })
})()
