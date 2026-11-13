// The journey panel (a webview). Plain DOM + SVG. Needs journeyModel.js (as `exports`), ELK and journey-graph.js, loaded before it.
// In:  { type: 'journey', journey,...tour }  { type: 'tour',...tour }  { type: 'deleted', file }  { type: 'tutorial' } (replay)
//      { type: 'test', click?: selector, key?: key } (integration tests drive the real handlers)
//      { type: 'anim', action: 'toggle' } (Ctrl+' P: the current step's animation on/off, as its row's toggle does)
//      tour = { current, marks, resume, legendHidden, problems, key, list (home), tutorial (offer the bar), prov? ({ text, tip,
//      changed }), card? (a step with no code to open: { n, lead, details?, refs, stale, staleText?, open }) }
// Layout (0.21): "‹ Journeys" (home: every journey, one click walks it), the question, one provenance line, then the
// storyline with the map beside it (wide) or above it (narrow, collapsible under "Map"). The map is the whole journey
// at once (journey-graph.js): pan, zoom, it follows the step; boxes open their code, step numbers walk to the step.
// Out: { type: 'ready' } { type: 'step', n } { type: 'end' } { type: 'rendered', boxes } { type: 'legend', hidden }
//      { type: 'openPath', path } { type: 'home' } { type: 'walk', key } { type: 'view', node } (the box the map centred on)
//      { type: 'tutorial', action: 'bar' | 'card' | 'skip' | 'done', card? } { type: 'error', message }
//      { type: 'ref', i } (a link in the step card) { type: 'ask' } { type: 'details', open }
//      { type: 'beat', n, i } (the animation's beat on step n; i = -1: the scene is gone)
;(function () {
  const vscode = acquireVsCodeApi()
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) }))
  const M = window.exports
  const app = document.getElementById('app')
  /** @type {any} */ let J
  let cur = 0
  /** step number -> 'stale' */
  let marks = {}
  let resume = 0
  let legendHidden = false
  let problems = []
  let problemsOpen = false
  let KEY = "Ctrl+'"
  let deleted = ''
  /** The step card, when it lives here ("panel"); undefined: it is in the editor. */
  let card
  const saved = vscode.getState() || {}
  /** The scroll to restore once after a reload. */
  let savedScroll = saved.scroll || 0
  const saveState = () => vscode.setState({ id: J && J.id, q: J && J.question, cur, n: J ? J.steps.length : 0, scroll: window.scrollY, mapShut, mapW, animOn })
  /** The step's animation is shown in place of the map: a toggle on the rows of steps that have one. */
  let animOn = !!saved.animOn
  /** The scene on screen ("journey|step"), so the editor's highlight is cleared when it goes. */
  let sceneKey = ''
  /** The beat each step's animation was on, during this walk: next step and back returns to it. */
  let beatAt = {}
  /** The next render puts the keyboard focus in the scene (it was started: ← → work at once). */
  let focusScene = false
  const sceneOf = (n) => { const s = J && J.steps[n - 1]; return s && s.scene && Array.isArray(s.scene.beats) && s.scene.beats.length ? s.scene : undefined }
  let firstRender = true
  /** The tutorial: offered (the bar), and the card shown (0: none). */
  let offer = false
  let tcard = 0
  /** What the last scroll followed ("step|level"): the map scrolls to the current box once per change. */
  let scrolled = ''

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  /** Enough markdown for summaries: `code` and **bold**. */
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  /** Step text: md plus [text](ref:i) links, ~~gone~~, paragraphs, "- " lists, ---. */
  function mdBlock(s) {
    const inline = (t) => md(t).replace(/\[([^\]]+)\]\(ref:(\d+)\)/g, '<button class="ref link" data-i="$2">$1</button>').replace(/\[([^\]]+)\]\(note:([\w.-]+)\)/g, '<button class="noteq link" data-id="$2">$1</button>').replace(/\[([^\]]+)\]\(ask:update\)/g, '<button class="askupd link">$1</button>').replace(/~~([^~]+)~~/g, '<s>$1</s>')
    // A fenced diff (a stale step:) is lines, coloured.
    const fences = []
    s = s.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_m, lang, body) => { fences.push(`<pre class="code">${body.split('\n').map((l) => `<span class="${lang === 'diff' && /^[-+]/.test(l) ? (l[0] === '-' ? 'del' : 'ins') : ''}">${esc(l)}</span>`).join('\n')}</pre>`); return `\u0000${fences.length - 1}\u0000` })
    return s.split(/\n{2,}/).map((p) => {
      const f = /^\u0000(\d+)\u0000$/.exec(p.trim())
      if (f) return fences[Number(f[1])]
      if (/^\s*---\s*$/.test(p)) return '<hr>'
      const ls = p.split('\n')
      if (ls.every((l) => /^\s*[-*] /.test(l))) return `<ul>${ls.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
      return `<p>${ls.map(inline).join('<br>')}</p>`
    }).join('')
  }
  const plain = (s) => s.replace(/`|\*\*/g, '')
  const post = (m) => vscode.postMessage(m)
  const markOf = (n) => marks[n] || ''

  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (m.type === 'journey') {
      const fresh = !J || J.id !== m.journey.id
      // Another journey starts at the top, its map in view: never the last one's scroll.
      if (fresh) { if (J) { savedScroll = 0; toTop = true } scrolled = ''; beatAt = {}; setHome(false) }
      J = m.journey
      deleted = ''
      tour(m)
      render()
    } else if (m.type === 'home') { tcard = 0; setHome(true); render() }
    else if (m.type === 'hello') post({ type: 'ready' })
    else if (m.type === 'tour') { tour(m); render() }
    else if (m.type === 'deleted') { deleted = m.file || 'the file'; tcard = 0; offer = false; render() }
    else if (m.type === 'tutorial') startTutorial()
    else if (m.type === 'anim' && m.action === 'toggle') toggleAnim()
    else if (m.type === 'code') { if (scene && animOn && m.n === cur && m.i === scene.beat) scene.code(m.code) }
    else if (m.type === 'anim' && m.action === 'off') { if (animOn) toggleAnim() }
    else if (m.type === 'test') {
      if (m.click) { const t = document.querySelector(m.click); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
      if (m.key) document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true }))
    }
  })

  /** A new position: the map shows the level holding the step (reversed); a level opened by hand stays until the step changes. */
  let authors = 0
  /** Narrow panels: the map above the storyline, folded away under "Map" by hand (0.20: shown by default). */
  let mapShut = !!saved.mapShut
  /** The map column's width when wide, dragged on the splitter (0.21.1); 0: the default. Kept here and by the extension. */
  let mapW = saved.mapW || 0
  /** Who wrote it and when; steps whose code changed since. */
  let prov
  /** The walk was just finished: Done, the summary, the list. */
  let done = false
  /** The next render starts at the top. */
  let toTop = false
  /** Steps asked about: n -> { id, state 'q'|'a', unread }. */
  let asked = {}
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
    done = !!m.done
    marks = m.marks || {}
    resume = Math.min(m.resume || 0, N)
    authors = m.authors || 0
    legendHidden = !!m.legendHidden
    if (!dragging) mapW = m.mapWidth || 0
    problems = m.problems || []
    card = m.card && cur ? m.card : undefined
    asked = m.asked || {}
    prov = m.prov
    if (m.key) KEY = m.key
    if (m.list) list = m.list
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
    const q = el('h1', 'q', J.question)
    q.title = J.question
    const hb = el('button', 'link homeb', '‹ Journeys')
    hb.title = 'All journeys'
    hb.onclick = goHome
    h.append(hb)
    top.append(q, stepControls())
    h.append(top)
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
    if (prov && (prov.text || prov.changed)) {
      const p = el('p', 'prov', prov.text || '')
      if (prov.tip) p.title = prov.tip
      // "out of date", not "changed since" (since what?); the tooltip says what happened.
      if (prov.changed) { const c = el('span', 'changed', `${prov.text ? ' · ' : ''}⚠ ${prov.changed} step${prov.changed === 1 ? '' : 's'} out of date`); c.title = 'The code changed after this journey was written'; p.append(c) }
      h.append(p)
    }
    if (problems.length) h.append(problemLine())
    return h
  }

  /** One short line when the journey can't be read or breaks the rules; the list on demand. */
  /** Readers see only what affects reading: the file can't be read now. */
  function problemLine() {
    const d = el('div', 'problems')
    const b = el('span', 'plink', `⚠ ${problems[0]} `)
    b.title = problems.join('\n')
    const o = el('button', 'link openfile', 'Open file')
    o.onclick = () => post({ type: 'openFile' })
    d.append(b, o)
    return d
  }
  /** Rule breaks only the author can fix: a quiet link to the Output channel. */
  function authorLink() {
    const a = el('button', 'link authors', `${authors} rule break${authors === 1 ? '' : 's'}`)
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
    const ol = el('ol', 'story')
    ol.setAttribute('aria-label', 'Steps')
    // Every step, always (no folded "n steps elsewhere").
    for (const s of J.steps) {
      const li = el('li')
      // It leads: every row is plain; only the current one and a stale one (its number amber:) stand out. No
      // mark where you stopped (after End nothing looks half on; the list says n/N).
      const b = el('button', ['st', s.n === cur ? 'cur' : '', markOf(s.n)].filter(Boolean).join(' '))
      b.dataset.n = s.n
      // Number and title only: no "later", no question marks (they are in the step card), no "stopped
      // here" (the quiet mark says it).
      b.append(el('span', 'n', String(s.n)), el('span', 't', s.title))
      if (markOf(s.n)) b.title = 'The code changed since this step was written'
      if (s.n === cur) b.setAttribute('aria-current', 'step')
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
    }
    return ol
  }

  /** The step card in the panel: lead, More, refs, ‹ ›, Ask. Links are posted back by index. */
  function stepCard() {
    const c = el('div', 'scard')
    c.setAttribute('role', 'region')
    c.setAttribute('aria-label', `Step ${cur}`)
    if (card.staleText) { const d = el('div', 'sstale'); d.innerHTML = mdBlock(card.staleText); c.append(d) }
    if (card.lead) { const d = el('div', 'slead'); d.innerHTML = mdBlock(card.lead); c.append(d) }
    const nav = el('div', 'snav')
    if (cur > 1) { const b = el('button', 'link sprev', '‹ Previous'); b.onclick = () => goStep(cur - 1); nav.append(b) }
    if (cur < J.steps.length) { const b = el('button', 'link snext', 'Next ›'); b.onclick = () => goStep(cur + 1); nav.append(b) }
    else { const b = el('button', 'link send', 'Finish'); b.onclick = () => post({ type: 'finish' }); nav.append(b) }
    // The step's questions live here only: a count, the unread colour for a new reply.
    if (asked[cur]) { const a = asked[cur], k = a.count || 1; const q = el('button', `link squestion${a.unread ? ' unread' : ''}`, `${k} question${k === 1 ? '' : 's'} ›`); q.onclick = () => post({ type: 'question', id: a.id }); nav.append(q) }
    // One Ask in a stale card: the banner's, which opens the request prefilled.
    if (!card.staleText) { const ask = el('button', 'link sask', 'Ask'); ask.onclick = () => post({ type: 'ask' }); nav.append(ask) }
    // More holds the details and the references (no bare link row).
    if (card.details || card.refs) {
      const m = el('button', 'link smore', card.open ? 'Less' : 'More')
      m.onclick = () => post({ type: 'details', open: !card.open })
      nav.append(m)
    }
    c.append(nav)
    if (card.open && card.details) { const d = el('div', 'sdetails'); d.innerHTML = mdBlock(card.details); c.append(d) }
    if (card.open && card.refs) { const d = el('div', 'srefs'); d.innerHTML = mdBlock(card.refs); c.append(d) }
    // A notice last, quiet.
    if (card.notice) c.append(el('div', 'snotice', `ℹ ${card.notice}`))
    // A reference reads as its file name; the whole path on hover.
    for (const r of c.querySelectorAll('.ref')) { const t = (card.paths || [])[Number(r.dataset.i)]; if (t) r.title = t }
    c.addEventListener('click', (e) => {
      const r = e.target.closest('.ref')
      if (r) { e.stopPropagation(); post({ type: 'ref', i: Number(r.dataset.i) }) }
      if (e.target.closest('.askupd')) { e.stopPropagation(); post({ type: 'ask', update: true }) }
      const nq = e.target.closest('.noteq')
      if (nq) { e.stopPropagation(); post({ type: 'question', id: nq.dataset.id }) }
    })
    return c
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
    if (!scene || !J || !cur || !sceneOf(cur) || tcard || deleted || home) return
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
    if (authors && !deleted) { const a = el('div', 'note'); a.append(authorLink()); wrap.append(a) }
    return wrap
  }

  // ---------- home (0.21): every journey, one click walks it ----------

  /** The journeys list shown in place of the journey (undefined: the journey). */
  let home
  let list = []
  /** The list in front (or not), and the tab says so. */
  function setHome(on) {
    if (!!home === on) return
    home = on || undefined
    post({ type: 'home', on })
  }
  function goHome() {
    if (tcard) return
    setHome(true)
    window.scrollTo(0, 0)
    render()
  }
  function homeView() {
    const h = el('div', 'home')
    h.append(el('h1', 'q', 'Journeys'))
    const ol = el('ul', 'jlist')
    for (const x of list) {
      const li = el('li')
      const b = el('button', `jrow${x.here ? ' here' : ''}${x.start ? ' start' : ''}`)
      const top = el('span', 'jtop')
      top.append(el('span', 't', x.title))
      // The one to begin with, then where it was left, quietly (a journey never opened has no mark).
      if (x.start) top.append(el('span', 'jstart', 'Start here'))
      if (x.resume) { const r = el('span', 'jat', `${x.resume}/${x.steps}`); r.title = `Left at step ${x.resume} of ${x.steps}`; top.append(r) }
      b.append(top)
      // The question under the title: what the sidebar doesn't show.
      if (x.question && x.question.toLowerCase() !== x.title.toLowerCase()) b.append(el('span', 'jq', x.question))
      b.onclick = () => { setHome(false); toTop = true; post({ type: 'walk', key: x.key }); render() }
      li.append(b)
      ol.append(li)
    }
    if (!list.length) h.append(el('p', 'note', 'No journeys in this workspace.'))
    h.append(ol)
    return h
  }

  // ---------- the splitter (0.21.1): the map column's width, dragged (wide panels only) ----------

  let dragging = false
  const MAPMIN = 240, STORYMIN = 280
  /** While the animation plays its column is at least SCENEMIN wide (Q6a: its text ≥ 11 px), still beside the
   *  storyline, which may narrow to STORYANIM. */
  const SCENEMIN = 400, STORYANIM = 160
  const animating = (body) => body.classList.contains('anim')
  const minW = (body) => (animating(body) ? SCENEMIN : MAPMIN)
  /** The widest the map may be in this body: the storyline keeps STORYMIN. */
  const maxW = (body) => Math.max(minW(body), body.clientWidth - (animating(body) ? STORYANIM : STORYMIN) - 21)
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
    const done = () => { if (!dragging) return; dragging = false; document.body.classList.remove('resizing'); keepW(shownW()) }
    s.addEventListener('pointerup', done)
    s.addEventListener('pointercancel', done)
    s.addEventListener('dblclick', () => { widthTo(body, 0); graph.resized(); keepW(0) })
    s.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0
      if (!d) return
      e.preventDefault()
      widthTo(body, shownW() + d)
      graph.resized()
      keepW(shownW())
    })
    return s
  }

  function render() {
    if (!J) return
    // The scene keeps the keyboard across a re-render (its element is taken out and put back).
    if (scene && scene.el.contains(document.activeElement)) focusScene = true
    // A re-render keeps the scroll; the first render after a reload goes back to where it was.
    const keepY = toTop ? 0 : firstRender ? savedScroll : window.scrollY
    if (toTop) window.scrollTo(0, 0)
    toTop = false
    firstRender = false
    app.textContent = ''
    app.classList.toggle('deleted', !!deleted)
    if (home) { app.append(homeView()); saveState(); return }
    if (offer && !tcard && !deleted) app.append(tutorialBar())
    const head = el('div', 'head')
    head.append(header())
    app.append(head)
    if (done && !cur && !deleted) app.append(doneView())
    // The storyline leads: the map beside it (wide) or above it (narrow, foldable under "Map"); too narrow for
    // boxes: none.
    const anim0 = !!scene && animOn && !!cur && !!sceneOf(cur) && !tcard && !deleted
    // Beside the storyline when both fit: the scene SCENEMIN wide, the storyline STORYANIM (Q6a); else above it.
    const wide = app.clientWidth >= (anim0 ? SCENEMIN + STORYANIM + 21 + 32 : 520)
    const tooNarrow = app.clientWidth < 240 && !tcard
    const body = el('div', 'body')
    const story = J.steps.length ? storyline() : el('p', 'note', 'This journey has no steps yet.')
    const hasMap = !tooNarrow
    const anim = anim0 && hasMap
    const shown = hasMap && (wide || !mapShut || !!tcard || !J.steps.length || anim)
    const m = shown ? (anim ? sceneEl() : mapEl()) : undefined
    if (!(shown && anim) && sceneKey) { sceneKey = ''; scene.forget(); post({ type: 'beat', n: 0, i: -1 }) }
    if (wide) { body.classList.add('wide'); body.classList.toggle('anim', anim); body.append(story, ...(m ? [splitter(body), m] : [])) }
    else {
      if (hasMap && J.steps.length && !tcard && !anim) {
        const t = el('button', 'link maptoggle', 'Map')
        t.setAttribute('aria-expanded', String(shown))
        t.title = shown ? 'Hide the map' : 'Show the map'
        t.onclick = () => { mapShut = !mapShut; render() }
        body.append(t)
      }
      body.append(...(m ? [m] : []), story)
    }
    app.append(body)
    if (wide && m) widthTo(body, mapW)
    const headH = head.offsetHeight
    document.documentElement.style.setProperty('--headH', `${headH}px`)
    graph.set(J, cur, legendHidden)
    if (m && !anim) graph.placed()
    if (m && anim) placeScene()
    if (keepY) window.scrollTo(0, keepY)
    savedScroll = 0
    follow()
    saveState()
    placeTutorial()
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
    const k = `${cur}`
    if (!cur || k === scrolled) return
    scrolled = k
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--headH')) || 0
    const into = (r) => { if (r.top < top + 4 || r.bottom > window.innerHeight - 4) window.scrollBy(0, r.top < top + 4 || r.height > window.innerHeight - top ? r.top - top - 12 : r.bottom - window.innerHeight + 16) }
    const row = app.querySelector('.story .st.cur')
    if (row) into(row.getBoundingClientRect())
  }

  // ---------- the tutorial: two cards on the real map (the storyline with the keys, the map) ----------

  /** The bar was dropped in this panel (skipped, or the walk got going): never offered again here. */
  let offerGone = false, offerSteps = 0
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

  let spot, tc, dim
  function placeTutorial() {
    spot?.remove(); tc?.remove(); dim?.remove(); spot = tc = dim = undefined
    if (!tcard) return
    const cs = cards()
    const c = cs[tcard - 1]
    const target = c.target()
    if (!target) return
    // The card first (hidden), to know its size before choosing where things go.
    tc = el('div', 'tcard')
    tc.setAttribute('role', 'dialog')
    const live = cs.filter((x) => !x.skip)
    tc.setAttribute('aria-label', `Tutorial ${live.indexOf(c) + 1} of ${live.length}`)
    if (c.node) { const p = el('div', 'ttext'); p.append(c.node); tc.append(p) } else tc.append(el('p', 'ttext', c.text))
    const foot = el('div', 'tfoot')
    // Dots only: where you are, no "1/6" beside them.
    const dots = el('span', 'dots')
    dots.setAttribute('aria-hidden', 'true')
    dots.textContent = live.map((x) => (cs.indexOf(x) < tcard ? '●' : '○')).join(' ')
    foot.append(dots)
    const nav = el('span', 'tnav')
    // The last card: no Skip (Esc leaves); Done finishes.
    let nb
    const last = live.indexOf(c) === live.length - 1
    if (!last) {
      const x = el('button', 'link tclose', 'Skip')
      x.title = 'Leave the tutorial (Esc)'
      x.onclick = leaveTutorial
      nav.append(x)
    }
    if (live.indexOf(c) > 0) { const b = el('button', 'link tback', 'Back'); b.onclick = () => tutorialMove(-1); nav.append(b) }
    nb = el('button', 'btn tnext', last ? 'Done' : 'Next'); nb.onclick = () => tutorialMove(1); nav.append(nb)
    foot.append(nav)
    tc.append(foot)
    tc.style.visibility = 'hidden'
    document.body.append(tc)
    const de = document.documentElement
    const W = de.clientWidth, H = window.innerHeight, G = 10, P = 4
    const cw = Math.min(320, W - 24)
    tc.style.width = `${cw}px`
    const ch = tc.offsetHeight
    // What scrolls goes below the sticky header, never under it; the target and the card both in view.
    const head = app.querySelector('.head')
    const inHead = !!head && head.contains(target)
    const top0 = inHead || !head ? 0 : head.getBoundingClientRect().bottom
    let r = target.getBoundingClientRect()
    const room = (q) => q.bottom + G + ch + G <= H || q.top - G - ch - G >= top0 || Math.max(W - q.right, q.left) >= cw + 2 * G
    if (!inHead && (r.top < top0 + P || r.bottom > H - P || !room(r))) {
      const free = H - top0
      const want = r.height + G + ch + 2 * G <= free ? top0 + Math.max(G, (free - r.height - G - ch) / 2) : top0 + G
      window.scrollBy(0, r.top - want)
      r = target.getBoundingClientRect()
    }
    // A target taller than the room (the storyline on a short panel): its visible top part, the card under it.
    const R = { left: r.left, right: r.right, top: Math.max(r.top, top0 + P), bottom: Math.min(r.bottom, H - P) }
    if (!room(R)) R.bottom = Math.max(R.top + 40, H - 2 * G - ch - P)
    const sx = window.scrollX, sy = window.scrollY
    spot = el('div', 'spot')
    Object.assign(spot.style, { left: `${R.left + sx - P}px`, top: `${R.top + sy - P}px`, width: `${R.right - R.left + 2 * P}px`, height: `${R.bottom - R.top + 2 * P}px` })
    // The dim: one layer over the whole page with a hole at the spot (a huge box-shadow is not always painted everywhere).
    dim = el('div', 'tdim')
    const PW = Math.max(de.scrollWidth, de.clientWidth), PH = Math.max(de.scrollHeight, window.innerHeight)
    const x1 = R.left + sx - P, y1 = R.top + sy - P, x2 = R.right + sx + P, y2 = R.bottom + sy + P
    Object.assign(dim.style, { width: `${PW}px`, height: `${PH}px` })
    dim.style.clipPath = `polygon(evenodd, 0 0, ${PW}px 0, ${PW}px ${PH}px, 0 ${PH}px, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`
    document.body.insertBefore(dim, tc)
    document.body.insertBefore(spot, tc)
    // Next to the element, never over it, never over the header, and over as little else as possible (R6).
    const minY = (inHead ? 0 : top0) + 4
    const clampX = (v) => Math.max(12, Math.min(v, W - cw - 12))
    const clampY = (v) => Math.max(minY, Math.min(v, H - ch - 8))
    const opts = [
      { x: clampX(R.left), y: R.bottom + G }, { x: clampX(R.right - cw), y: R.bottom + G },
      { x: clampX(R.left), y: R.top - G - ch }, { x: clampX(R.right - cw), y: R.top - G - ch },
      { x: R.right + G, y: clampY(R.top) }, { x: R.left - G - cw, y: clampY(R.top) },
      { x: clampX(W - cw - 12), y: R.bottom + G }, { x: 12, y: R.bottom + G },
    ].filter((o) => o.x >= 12 && o.x + cw <= W - 12 && o.y >= minY && o.y + ch <= H - 4)
    const avoid = [...app.querySelectorAll('.mapwrap, .story, h1.q, .prov, .tour')].filter((e) => e !== target && !e.contains(target) && !target.contains(e)).map((e) => { const q = e.getBoundingClientRect(); return { left: q.left, right: q.right, top: q.top, bottom: q.bottom, w: e.classList.contains('mapwrap') ? 1e4 : 1 } })
    const area = (o, q) => Math.max(0, Math.min(o.x + cw, q.right) - Math.max(o.x, q.left)) * Math.max(0, Math.min(o.y + ch, q.bottom) - Math.max(o.y, q.top))
    const hitsTarget = (o) => area(o, { left: R.left - P, right: R.right + P, top: R.top - P, bottom: R.bottom + P }) > 0
    const score = (o) => (hitsTarget(o) ? 1e9 : 0) + avoid.reduce((sum, q) => sum + area(o, q) * q.w, 0)
    const at = opts.length ? opts.reduce((b, o) => (score(o) < score(b) ? o : b)) : { x: clampX(R.left), y: clampY(R.bottom + G) }
    tc.style.left = `${at.x + sx}px`
    tc.style.top = `${at.y + sy}px`
    tc.style.visibility = ''
    ;(nb || target).focus({ preventScroll: true })
  }

  document.addEventListener('keydown', (e) => {
    if (tcard) {
      if (e.key === 'Escape') { e.preventDefault(); leaveTutorial(); return }
      // Enter on a button or box is its own click; anywhere else it is Next.
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest?.('button, .box'))) { e.preventDefault(); tutorialMove(1); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); tutorialMove(-1); return }
      return
    }
  })
  // Re-lay out when the size changes, a frame later (rendering inside the observer would loop it).
  let size = '', frame = 0
  const relayout = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { const s = `${app.clientWidth}x${window.innerHeight}`; if (J && s !== size) { size = s; render() } })
  }
  new ResizeObserver(relayout).observe(app)
  let st = 0
  window.addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => { if (J) saveState() }, 300) })
  window.addEventListener('resize', relayout)
  post({ type: 'ready' })
})()
