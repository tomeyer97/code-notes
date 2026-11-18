// The journey panel (a webview). Plain DOM + SVG. Needs common.js, journeyModel.js (as `JourneyModel`), ELK,
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
//   { type: 'beat', n, i } (the animation's beat on step n; i = -1: the scene is gone)
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
    vscode.setState({ id: J && J.id, q: J && J.question, cur, n, scroll: window.scrollY, mapShut, mapW, animOn })
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
    end.onclick = () => post({ type: 'end' })
    t.append(end)
    return t
  }

  // ---------- storyline: the step titles; the current one expanded when the card lives here ----------

  function storyline() {
    const { stops, card } = T
    const ol = el('ol', 'story')
    ol.setAttribute('aria-label', 'Steps')
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
      li.append(b)
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
    }
    return ol
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
    onBeat: (i) => { if (sceneKey) beatAt[sceneKey] = i; post({ type: 'beat', n: cur, i }) },
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
    scene.show(sceneOf(cur), k, { file: J.steps[cur - 1].file, next: cur < J.steps.length, beat: beatAt[k] || 0 })
    if (fresh || focusScene) scene.focus()
    focusScene = false
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
    if (tutorial.offered && !tutorial.card && !deleted) app.append(tutorial.bar())
    const head = el('div', 'head')
    head.append(header())
    app.append(head)
    if (T.done && !cur && !deleted) app.append(doneView())
    // The storyline leads: the map beside it (wide) or above it (narrow, foldable under "Map"); too narrow for
    // boxes: none.
    const L = chooseLayout()
    const body = el('div', 'body')
    const story = J.steps.length ? storyline() : el('p', 'note', 'This journey has no steps yet.')
    const m = L.shown ? (L.anim ? sceneEl() : mapEl()) : undefined
    // No animation on screen any more: the editor's highlight of its beat goes too.
    if (!(L.shown && L.anim) && sceneKey) { sceneKey = ''; scene.forget(); post({ type: 'beat', n: 0, i: -1 }) }
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

  /** A row closer than this (px) to the sticky header or the window's bottom is scrolled into view. */
  const ROW_MARGIN = 4
  /** Where a row scrolled into view lands: this far (px) under the header, or above the window's bottom. */
  const ROW_TOP_GAP = 12, ROW_BOTTOM_GAP = 16
  /** Scrolls the page so row rectangle `r` (viewport px) is in view under the header (its bottom at `top`): at the
   *  top when it was above or is taller than the room, else just up from the bottom. */
  function scrollRowIntoView(r, top) {
    const H = window.innerHeight
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
