// The journey panel (a webview). Plain DOM + SVG. Needs common.js, journeyModel.js (as `exports`), ELK,
// journey-layout.js, journey-graph.js, journey-scene.js and journey-home.js, loaded before it.
// Layout (0.21): "‹ Journeys" (home: every journey, one click walks it), the question, one provenance line, then the
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
  /** Narrow panels: the map above the storyline, folded away under "Map" by hand (0.20: shown by default). */
  let mapShut = !!saved.mapShut
  /** The map column's width when wide, dragged on the splitter (0.21.1); 0: the default. Kept here and by the extension. */
  let mapW = saved.mapW || 0
  /** The splitter is being dragged (a tour message doesn't move it meanwhile). */
  let dragging = false
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

  // The tutorial.
  /** The bar is offered ("New here?"); the card shown (0: none). */
  let offer = false
  let tcard = 0
  /** The bar was dropped in this panel (skipped, or the walk got going): never offered again here. */
  let offerGone = false
  /** Steps walked since the bar was offered (at two it goes). */
  let offerSteps = 0
  /** The tutorial's elements on the page: the ring, the card, the dim. */
  let spot, tc, dim

  // Waiting (startup, at the end): the size last rendered and the frame a re-layout waits for; the scroll saved and
  // the panel's width reported once things settle.
  let renderedSize = ''
  let relayoutFrame = 0
  let scrollTimer = 0
  let widthTimer = 0

  const saveState = () => vscode.setState({ id: J && J.id, q: J && J.question, cur, n: J ? J.steps.length : 0, scroll: window.scrollY, mapShut, mapW, animOn })
  const sceneOf = (n) => { const s = J && J.steps[n - 1]; return s && s.scene && Array.isArray(s.scene.beats) && s.scene.beats.length ? s.scene : undefined }

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
    home() { tcard = 0; setHome(true); render() },
    hello() { post({ type: 'ready' }) },
    preview(m) { home.preview(m) },
    deleted(m) { deleted = m.file || 'the file'; tcard = 0; offer = false; render() },
    tutorial() { startTutorial() },
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
    // A step opened (D, a click in the code): the journey, not the list. The walk ended: back to the top.
    if (cur && cur !== was) setHome(false)
    if (!cur && was) { toTop = true; scrolled = ''; beatAt = {}; animOn = false }
    // The "New here?" bar goes once the walk is under way: two steps on, as if skipped.
    if (cur && cur !== was && offer && ++offerSteps >= 2) dropOffer()
    T = tourOf(m, cur)
    legendHidden = !!m.legendHidden
    if (!dragging) mapW = m.mapWidth || 0
    if (m.key) KEY = m.key
    home.take(m)
    if (m.tutorial && !offer && !tcard && !offerGone) { offer = true; offerSteps = 0; post({ type: 'tutorial', action: 'bar' }) }
    if (!m.tutorial) offer = false
  }

  function goStep(n) {
    // The tutorial is a sandbox: a step clicked on card 3 moves the tutorial on, not your place in the journey.
    // Card 3 says "click one to see its code": it does, and the tutorial goes on.
    // The tutorial is a sandbox: no tour starts under it.
    if (tcard) return
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
    if (J.title && J.question && J.question.toLowerCase() !== J.title.toLowerCase()) { const sq = el('p', 'qsub', J.question); sq.title = J.question; h.append(sq) }
    if (deleted) {
      // "Deleted · Restore": the tab closes like any tab, the picker is a command.
      const g = el('p', 'gone', 'Deleted')
      const r = el('button', 'link restore', 'Restore'); r.onclick = () => post({ type: 'restore' })
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
      if (prov.changed) { const c = el('span', 'changed', `${prov.text ? ' · ' : ''}⚠ ${prov.changed} step${prov.changed === 1 ? '' : 's'} out of date`); c.title = 'The code changed after this journey was written'; p.append(c) }
      h.append(p)
    }
    if (T.problems.length) h.append(problemLine())
    return h
  }

  /** One short line when the journey can't be read or breaks the rules; the list on demand. */
  /** Readers see only what affects reading: the file can't be read now. */
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
      if (scene && s.n === cur && sceneOf(s.n) && !(animOn && !tcard)) {
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
    b.onclick = () => { if (!tcard && !deleted) post({ type: 'checkpoint', id: q.id }) }
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

  // ---------- the map (0.21): the whole journey at once, panned and zoomed (journey-graph.js) ----------

  const graph = window.JourneyGraph({
    goStep: (n) => goStep(n),
    open: (path) => post({ type: 'openPath', path }),
    quiet: () => !!tcard,
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
    if (!scene || !J || !cur || !sceneOf(cur) || tcard || deleted || home.on) return
    animOn = !animOn
    if (animOn) { focusScene = true; dropOffer() }
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
    render: () => render(),
    walk: (k) => walkKey(k),
    walking: () => !!J,
    busy: () => !!tcard,
  })
  const setHome = (on) => home.set(on)
  function goHome() { if (!tcard) home.open() }
  function walkKey(k) { if (!k) return; setHome(false); toTop = true; post({ type: 'walk', key: k }); render() }

  // ---------- the splitter (0.21.1): the map column's width, dragged (wide panels only) ----------

  /** The map column and the storyline beside it are at least this wide (px); a panel narrower than MAPMIN shows no map. */
  const MAPMIN = 240, STORYMIN = 280
  /** While the animation plays its column is at least SCENEMIN wide (Q6a: its text ≥ 11 px), still beside the
   *  storyline, which may narrow to STORYANIM. */
  const SCENEMIN = 400, STORYANIM = 160
  /** The splitter's column with the gaps beside it (13 + 2 × 4 px), and the panel's padding (16 px each side). */
  const SPLITTER_W = 21, GUTTER = 32
  /** The map goes beside the storyline from this panel width (no animation playing). */
  const WIDE_MIN = 520
  /** How far ← → move the splitter (px). */
  const SPLITTER_STEP = 24
  const animating = (body) => body.classList.contains('anim')
  const minW = (body) => (animating(body) ? SCENEMIN : MAPMIN)
  /** The widest the map may be in this body: the storyline keeps STORYMIN. */
  const maxW = (body) => Math.max(minW(body), body.clientWidth - (animating(body) ? STORYANIM : STORYMIN) - SPLITTER_W)
  /** Sets the map column to `w` px (0: the default), clamped; the map keeps its step in view. */
  function widthTo(body, w) {
    if (!w && animating(body)) w = Math.max(SCENEMIN, body.clientWidth * 0.54)
    if (w) body.style.setProperty('--mapw', `${Math.round(Math.max(minW(body), Math.min(maxW(body), w)))}px`)
    else body.style.removeProperty('--mapw')
    const sp = body.querySelector('.splitter')
    if (sp) sp.setAttribute('aria-valuenow', String(Math.round(app.querySelector('.mapwrap')?.offsetWidth || 0)))
  }
  const shownW = () => app.querySelector('.mapwrap')?.offsetWidth || 0
  /** The width chosen: remembered here and by the extension (every panel, every journey); 0 resets to the default. */
  function keepW(w) { mapW = w; saveState(); post({ type: 'mapWidth', w }) }
  function splitter(body) {
    const s = el('div', 'splitter')
    s.tabIndex = 0
    s.setAttribute('role', 'separator')
    s.setAttribute('aria-orientation', 'vertical')
    s.setAttribute('aria-label', 'Map width')
    s.title = 'Drag to resize the map (double-click: default)'
    let x0 = 0, w0 = 0
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging = true
      x0 = e.clientX
      w0 = shownW()
      s.setPointerCapture(e.pointerId)
      document.body.classList.add('resizing')
    })
    s.addEventListener('pointermove', (e) => {
      if (!dragging) return
      widthTo(body, w0 + (x0 - e.clientX))
      graph.resized()
    })
    const release = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing')
      keepW(shownW())
    }
    s.addEventListener('pointerup', release)
    s.addEventListener('pointercancel', release)
    s.addEventListener('dblclick', () => { widthTo(body, 0); graph.resized(); keepW(0) })
    s.addEventListener('keydown', (e) => {
      const by = (d) => () => {
        widthTo(body, shownW() + d)
        graph.resized()
        keepW(shownW())
      }
      runKey(e, { ArrowLeft: by(SPLITTER_STEP), ArrowRight: by(-SPLITTER_STEP) })
    })
    return s
  }

  // ---------- render: the whole panel again from the state ----------

  function render() {
    if (!J) return
    const keepY = beforeRender()
    app.textContent = ''
    app.classList.toggle('deleted', !!deleted)
    if (home.on) { home.draw(); saveState(); return }
    if (offer && !tcard && !deleted) app.append(tutorialBar())
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
      body.append(story, ...(m ? [splitter(body), m] : []))
    } else {
      if (L.hasMap && J.steps.length && !tcard && !L.anim) body.append(mapToggle(L.shown))
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
    // The step's animation is on (and nothing else is in front).
    const animOnStep = !!scene && animOn && !!cur && !!sceneOf(cur) && !tcard && !deleted
    // Beside the storyline when both fit: the scene SCENEMIN wide, the storyline STORYANIM (Q6a); else above it.
    const wide = app.clientWidth >= (animOnStep ? SCENEMIN + STORYANIM + SPLITTER_W + GUTTER : WIDE_MIN)
    const tooNarrow = app.clientWidth < MAPMIN && !tcard
    const hasMap = !tooNarrow
    const anim = animOnStep && hasMap
    // Narrow: folded under "Map" by hand, but never while the tutorial points at it, with no steps, or animating.
    const shown = hasMap && (wide || !mapShut || !!tcard || !J.steps.length || anim)
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
    if (L.wide && m) widthTo(body, mapW)
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
    placeTutorial()
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
    if (tcard) return
    const at = T.stops.find((q) => q.cur)
    const k = `${cur}|${at ? at.id : ''}`
    if (!cur || k === scrolled) return
    scrolled = k
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--headH')) || 0
    const into = (r) => { if (r.top < top + 4 || r.bottom > window.innerHeight - 4) window.scrollBy(0, r.top < top + 4 || r.height > window.innerHeight - top ? r.top - top - 12 : r.bottom - window.innerHeight + 16) }
    const row = app.querySelector('.story .st.cur, .story .cp.cur')
    if (row) into(row.getBoundingClientRect())
  }

  // ---------- the tutorial: two cards on the real map (the storyline with the keys, the map) ----------

  function dropOffer() {
    if (!offer) return
    offer = false
    offerGone = true
    post({ type: 'tutorial', action: 'skip' })
  }
  function tutorialBar() {
    const b = el('div', 'tbar')
    b.append(el('span', 'tq', 'New here?'))
    const go = el('button', 'link tstart', 'Show me how')
    go.onclick = () => startTutorial()
    const skip = el('button', 'link tskip', 'Skip')
    skip.onclick = () => { dropOffer(); render() }
    b.append(go, el('span', 'sep', '·'), skip)
    return b
  }

  function startTutorial() {
    if (!J || deleted) return
    offer = false
    tcard = 1
    render()
    // The first card that has something to point at.
    if (cards()[0].skip) tutorialMove(1)
    else post({ type: 'tutorial', action: 'card', card: 1, editor: cards()[0].editor || false })
  }

  /** The cards: what each one points at, and what it says. A card with nothing to point at is skipped. */
  function cards() {
    // One thing per card (the first card was far too wordy): the storyline, the card in the editor, its linked
    // phrases and the animation (where the journey has them), the map. The two about the card are shown in the editor itself. Plain sentences. What only some journeys have (animations, tinted phrases) is said only there.
    const anims = J.steps.some((x) => x.scene), tints = J.steps.some((x) => x.links && x.links.length)
    const story = () => app.querySelector('.story')
    // the storyline leads; the map beside it.
    return [
      { target: story, text: 'The steps, in the order things happen. Click one to see its code.', skip: !J.steps.length },
      // The card is in the editor: the extension opens a step there and boxes its lines (`editor`); here, its row.
      { target: () => app.querySelector('.story .st.cur') || story(), text: 'In the editor, the card above the code explains the step. Highlighted there now: Next, Ask and More.', skip: !J.steps.length, editor: 'card' },
      { target: () => app.querySelector('.story .st.cur') || story(), text: 'The phrases highlighted in that card now are links. Click one to see the code that does it.', skip: !J.steps.length || !tints, editor: 'links' },
      // The animation's button, under the step the editor card opened (no keys card).
      { target: () => app.querySelector('.story .animbtn') || app.querySelector('.story .st.cur') || story(), text: '"Show animation" plays the step beat by beat in place of the map. Each beat shows the line of code that does it.', skip: !J.steps.length || !anims },
      { target: () => app.querySelector('.mapwrap'), text: 'Where each step happens; the numbers are the steps, click one to go there. Drag to move, Ctrl+wheel to zoom.', skip: !app.querySelector('.mapwrap') },
    ]
  }

  function tutorialMove(d) {
    const cs = cards()
    let n = tcard + d
    while (n >= 1 && n <= cs.length && cs[n - 1].skip) n += d
    if (n < 1) return
    if (n > cs.length) return finishTutorial()
    tcard = n
    post({ type: 'tutorial', action: 'card', card: n, editor: cs[n - 1].editor || false })
    render()
  }
  function leaveTutorial() { tcard = 0; post({ type: 'tutorial', action: 'skip' }); render() }
  function finishTutorial() { tcard = 0; post({ type: 'tutorial', action: 'done' }); render() }

  /** The space between the card and what it points at, around the screen's edges (GAP); the ring's padding (PAD). */
  const GAP = 10, PAD = 4
  /** The card's widest (px) and its margin from the panel's sides. */
  const CARD_W = 320, EDGE = 12
  /** In the scoring of the card's places: covering what it points at is never chosen if anything else fits, and
   *  covering the map counts this many times its area (the rest once). */
  const ON_TARGET = 1e9, MAP_WEIGHT = 1e4

  /** The current card: the dim with a hole around what it points at, a ring in the hole, the card next to it. */
  function placeTutorial() {
    spot?.remove(); tc?.remove(); dim?.remove(); spot = tc = dim = undefined
    if (!tcard) return
    const cs = cards()
    const c = cs[tcard - 1]
    const target = c.target()
    if (!target) return
    // The card first (hidden), to know its size before choosing where things go.
    const { card, next } = buildCard(cs, c)
    tc = card
    tc.style.visibility = 'hidden'
    document.body.append(tc)
    const W = document.documentElement.clientWidth, H = window.innerHeight
    const cw = Math.min(CARD_W, W - 2 * EDGE)
    tc.style.width = `${cw}px`
    const ch = tc.offsetHeight
    // What scrolls goes below the sticky header, never under it; the target and the card both in view.
    const head = app.querySelector('.head')
    const inHead = !!head && head.contains(target)
    const top0 = inHead || !head ? 0 : head.getBoundingClientRect().bottom
    const box = { W, H, cw, ch }
    const R = scrollIntoRoom(target, inHead, top0, box)
    const sx = window.scrollX, sy = window.scrollY
    dimAround(R, sx, sy)
    // Next to the element, never over it, never over the header, and over as little else as possible (R6).
    const at = bestSpot(R, target, (inHead ? 0 : top0) + 4, box)
    tc.style.left = `${at.x + sx}px`
    tc.style.top = `${at.y + sy}px`
    tc.style.visibility = ''
    ;(next || target).focus({ preventScroll: true })
  }

  /** Card `c` of `cs`: its text, the dots (where you are), Skip / Back / Next (Done on the last). */
  function buildCard(cs, c) {
    const card = el('div', 'tcard')
    card.setAttribute('role', 'dialog')
    const live = cs.filter((x) => !x.skip)
    card.setAttribute('aria-label', `Tutorial ${live.indexOf(c) + 1} of ${live.length}`)
    if (c.node) { const p = el('div', 'ttext'); p.append(c.node); card.append(p) } else card.append(el('p', 'ttext', c.text))
    const foot = el('div', 'tfoot')
    // Dots only: where you are, no "1/6" beside them.
    const dots = el('span', 'dots')
    dots.setAttribute('aria-hidden', 'true')
    dots.textContent = live.map((x) => (cs.indexOf(x) < tcard ? '●' : '○')).join(' ')
    foot.append(dots)
    const nav = el('span', 'tnav')
    // The last card: no Skip (Esc leaves); Done finishes.
    const last = live.indexOf(c) === live.length - 1
    if (!last) {
      const x = button('link tclose', 'Skip', leaveTutorial)
      x.title = 'Leave the tutorial (Esc)'
      nav.append(x)
    }
    if (live.indexOf(c) > 0) nav.append(button('link tback', 'Back', () => tutorialMove(-1)))
    const next = button('btn tnext', last ? 'Done' : 'Next', () => tutorialMove(1))
    nav.append(next)
    foot.append(nav)
    card.append(foot)
    return { card, next }
  }

  /** Scrolls `target` into view with room for the card (ch high, cw wide; the panel W × H) below the header (its
   *  bottom at top0), and returns its visible rectangle (viewport px): of a target taller than the room, its top part. */
  function scrollIntoRoom(target, inHead, top0, { W, H, cw, ch }) {
    let r = target.getBoundingClientRect()
    // Room for the card below it, above it, or beside it.
    const room = (q) => q.bottom + GAP + ch + GAP <= H || q.top - GAP - ch - GAP >= top0 || Math.max(W - q.right, q.left) >= cw + 2 * GAP
    if (!inHead && (r.top < top0 + PAD || r.bottom > H - PAD || !room(r))) {
      const free = H - top0
      const want = r.height + GAP + ch + 2 * GAP <= free ? top0 + Math.max(GAP, (free - r.height - GAP - ch) / 2) : top0 + GAP
      window.scrollBy(0, r.top - want)
      r = target.getBoundingClientRect()
    }
    // A target taller than the room (the storyline on a short panel): its visible top part, the card under it.
    const R = { left: r.left, right: r.right, top: Math.max(r.top, top0 + PAD), bottom: Math.min(r.bottom, H - PAD) }
    if (!room(R)) R.bottom = Math.max(R.top + 40, H - 2 * GAP - ch - PAD)
    return R
  }

  /** The dim over the whole page with a hole at R (viewport px), and the ring in the hole. One layer with a clip-path
   *  (a huge box-shadow is not always painted everywhere). */
  function dimAround(R, sx, sy) {
    const de = document.documentElement
    spot = el('div', 'spot')
    Object.assign(spot.style, { left: `${R.left + sx - PAD}px`, top: `${R.top + sy - PAD}px`, width: `${R.right - R.left + 2 * PAD}px`, height: `${R.bottom - R.top + 2 * PAD}px` })
    dim = el('div', 'tdim')
    // The page's size, and the hole (page px).
    const PW = Math.max(de.scrollWidth, de.clientWidth), PH = Math.max(de.scrollHeight, window.innerHeight)
    const x1 = R.left + sx - PAD, y1 = R.top + sy - PAD, x2 = R.right + sx + PAD, y2 = R.bottom + sy + PAD
    Object.assign(dim.style, { width: `${PW}px`, height: `${PH}px` })
    dim.style.clipPath = `polygon(evenodd, 0 0, ${PW}px 0, ${PW}px ${PH}px, 0 ${PH}px, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`
    document.body.insertBefore(dim, tc)
    document.body.insertBefore(spot, tc)
  }

  /** Where the card goes (viewport px, its top left): of the places beside R that fit on screen (below minY), the one
   *  that covers least of what matters (never R itself if anything else fits); none fits: under R, kept on screen. */
  function bestSpot(R, target, minY, { W, H, cw, ch }) {
    const clampX = (v) => Math.max(EDGE, Math.min(v, W - cw - EDGE))
    const clampY = (v) => Math.max(minY, Math.min(v, H - ch - 8))
    const below = R.bottom + GAP, above = R.top - GAP - ch
    const candidates = [
      { x: clampX(R.left), y: below }, // below, left-aligned
      { x: clampX(R.right - cw), y: below }, // below, right-aligned
      { x: clampX(R.left), y: above }, // above, left-aligned
      { x: clampX(R.right - cw), y: above }, // above, right-aligned
      { x: R.right + GAP, y: clampY(R.top) }, // to the right
      { x: R.left - GAP - cw, y: clampY(R.top) }, // to the left
      { x: clampX(W - cw - EDGE), y: below }, // below, at the right edge
      { x: EDGE, y: below }, // below, at the left edge
    ]
    const fits = candidates.filter((o) => o.x >= EDGE && o.x + cw <= W - EDGE && o.y >= minY && o.y + ch <= H - 4)
    if (!fits.length) return { x: clampX(R.left), y: clampY(R.bottom + GAP) }
    // What the card should not cover (besides the target): the map most of all, the storyline, the title, the header.
    const avoid = [...app.querySelectorAll('.mapwrap, .story, h1.q, .prov, .tour')]
      .filter((e) => e !== target && !e.contains(target) && !target.contains(e))
      .map((e) => {
        const q = e.getBoundingClientRect()
        return { left: q.left, right: q.right, top: q.top, bottom: q.bottom, w: e.classList.contains('mapwrap') ? MAP_WEIGHT : 1 }
      })
    const area = (o, q) => Math.max(0, Math.min(o.x + cw, q.right) - Math.max(o.x, q.left)) * Math.max(0, Math.min(o.y + ch, q.bottom) - Math.max(o.y, q.top))
    const hitsTarget = (o) => area(o, { left: R.left - PAD, right: R.right + PAD, top: R.top - PAD, bottom: R.bottom + PAD }) > 0
    const score = (o) => (hitsTarget(o) ? ON_TARGET : 0) + avoid.reduce((sum, q) => sum + area(o, q) * q.w, 0)
    return fits.reduce((b, o) => (score(o) < score(b) ? o : b))
  }

  // While a card is up: Esc leaves, → (or Enter, but on a button or box: its own click) goes on, ← back.
  document.addEventListener('keydown', (e) => {
    if (!tcard) return
    runKey(e, {
      Escape: () => leaveTutorial(),
      ArrowRight: () => tutorialMove(1),
      Enter: !e.target.closest?.('button, .box') && (() => tutorialMove(1)),
      ArrowLeft: () => tutorialMove(-1),
    })
  })

  // ---------- startup ----------

  // Re-lay out when the size changes, a frame later (rendering inside the observer would loop it).
  const relayout = () => {
    cancelAnimationFrame(relayoutFrame)
    relayoutFrame = requestAnimationFrame(() => {
      const s = `${app.clientWidth}x${window.innerHeight}`
      if (J && s !== renderedSize) { renderedSize = s; render() }
    })
  }
  // The panel's width as the reader drags it: the extension keeps it for the next walk.
  const reportWidth = () => {
    clearTimeout(widthTimer)
    widthTimer = setTimeout(() => post({ type: 'panelWidth', w: window.innerWidth }), 500)
  }
  new ResizeObserver(relayout).observe(app)
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => { if (J) saveState() }, 300)
  })
  window.addEventListener('resize', () => { relayout(); reportWidth() })
  post({ type: 'ready' })
})()
