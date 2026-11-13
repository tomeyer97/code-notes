// A step's animation: a small scene played beat by beat in place of the map. Plain DOM; styles are set
// through the CSSOM (the webview's CSP allows no inline style attributes). Needs journey-scene.css.
//
// A scene is data on a journey step (`scene`):
//   actors: [{ id, type, col, ... }]   type: app | browser | service | table | cluster | terminal | file | chat | queue | gauge  (a fixed library: one look everywhere)
//             (`console` is read as `app`); a cluster may hold one cluster inside it (`inner`: a virtual cluster in a namespace)
//   wires:  [[fromId, toId]]           lines requests travel on
//   beats:  [{ focus, caption, muted?, set?, packet?, click?, code?, example? }]
//     focus:   an actor id — the camera goes there, the rest dims. Old data's "all" (a zoomed-out overview, too small
//              to read) keeps the camera on the last focused actor; only the caption changes.
//     set:     { actorId: { ... } } — what changes; a beat's state is every `set` up to it, so going back just works
//     packet:  { from, to, label } — a pill travelling a wire as the beat starts
//     code:    { file, line, text } — the line that does this (the extension lights it)
//     example: { label, value, lang? } — an example of what is in play there (shown at that line in the editor, not here)
// Used by journey-map.js (the panel) and test/journey-scene/player.html (a page that plays a scene, for videos).
;(function () {
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const svg = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  // Sized so that at a 400 px wide scene the camera's scale is about 1 (camera(): min(vw / (w + 56), vh / (h + 36)),
  // view ≈ 398 × 294), and every text rule is at least 11.5 px: nothing on screen below 11 px.
  const SIZE = { browser: [320, 250], app: [320, 250], service: [290, 240], table: [350, 150], cluster: [350, 140], terminal: [320, 198], file: [320, 180], chat: [320, 200], queue: [350, 132], gauge: [350, 132] }
  /** A table grows with its rows (rows never past the box); a service is as tall as its checks (no empty box). */
  const sizeOf = (a) => a.type === 'table' ? [SIZE.table[0], Math.max(SIZE.table[1], 58 + 40 * (a.rows || []).length)]
    : a.type === 'service' ? [SIZE.service[0], Math.min(SIZE.service[1], Math.max(150, 62 + (a.fn ? 32 : 0) + 25 * (a.checks || []).length))]
    : a.type === 'file' ? [SIZE.file[0], 60 + 20 * Math.min(8, Math.max(3, (a.lines || []).length))]
    : a.type === 'chat' ? [SIZE.chat[0], 58 + 36 * Math.min(4, Math.max(2, (a.messages || []).length))]
    : a.type === 'terminal' ? [SIZE.terminal[0], 66 + 22 * Math.min(6, Math.max(3, (a.lines || []).length))]
    : a.type === 'cluster' && a.inner ? [SIZE.cluster[0], ((a.pods || []).length ? 126 : 50) + 122]
    : SIZE[a.type === 'console' ? 'app' : a.type]
  const COL_GAP = 100, ROW_GAP = 20

  // ---------- the actors ----------

  function frame(a) {
    const e = h('div', `scn-actor scn-${a.type}`)
    const l = h('div', 'scn-label')
    l.append(h('b', '', a.label || a.id))
    if (a.sub) l.append(h('span', '', ` · ${a.sub}`))
    e.append(l)
    return e
  }

  // Older journeys name the app actor's type `console` and its screens `run-dialog`, `run-page`, `login`, with flat
  // fields (test, env, status, findings, timeline, chat, provider): all still read, as aliases and fallbacks.
  const SCREEN_ALIAS = { 'run-dialog': 'dialog', 'run-page': 'detail', login: 'signin' }
  const TONE_OF = { running: 'active', passed: 'good', failed: 'bad' }
  const TONES = ['neutral', 'active', 'good', 'bad']

  /** A web app's window, in its own dark colours so it reads as an app in any editor theme. Everything it says is
   *  data: `brand`, `logo` (1-2 letters), `tabs` (≤ 3, each screen marks its own) and three built-in screens, few and
   *  large items on each:
   *    `dialog`: a list page with a dialog over it: its title, the one chosen item, ≤ 2 label/value lines, a button;
   *    `detail`: a title and a status chip, ≤ 2 cards (a severity dot each), the last timeline rows, and two
   *              panes a beat can switch to: a live picture (`picture`) and a chat;
   *    `signin`: a title, a notice, one button (`provider`).
   *  Any other page is one of `pages`. A beat's `click` presses the button of the screen that is shown. */
  function appActor(a) {
    const brand = String(a.brand || 'App')
    const dg = obj(a.dialog), dt = obj(a.detail), sg = obj(a.signin)
    const tabs = (Array.isArray(a.tabs) ? a.tabs : []).slice(0, 3).map(String)
    const e = frame({ ...a, type: 'app', label: a.label || 'Web app' })
    const mkLogo = (cls) => h('span', `ap-logo${cls ? ` ${cls}` : ''}`, String(a.logo || brand.charAt(0) || 'A').slice(0, 2))
    const mkCursor = () => {
      const c = svg('svg', { viewBox: '0 0 20 24', class: 'scn-cursor' })
      c.append(svg('path', { d: 'M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.7 L9.6 13 L15.5 13 Z', fill: '#fff', stroke: '#000', 'stroke-width': 1.2 }))
      return c
    }
    // The app's bar: logo, name, its tabs (the screen's own one marked).
    const chrome = (tab) => {
      const top = h('div', 'ap-top')
      top.append(mkLogo(), h('b', '', brand))
      if (tabs.length) {
        const ts = h('span', 'ap-tabs')
        for (const t of tabs) ts.append(h('span', t === tab ? 'on' : '', t))
        top.append(ts)
      }
      return top
    }
    const screen = (name, cls) => { const s = h('div', `ap-win scn-screen${cls ? ` ${cls}` : ''}`); s.dataset.screen = name; return s }
    const item = String(dg.item || a.test || 'Item')
    // The list page under the dialog
    const s1 = screen('dialog')
    s1.append(chrome(dg.tab))
    const tbl = h('div', 'ap-table')
    tbl.append(h('div', 'ap-tr', item))
    const dlg = h('div', 'ap-dialog')
    dlg.append(h('div', 'ap-dh', dg.title || 'Confirm'))
    const pick = h('div', 'ap-radio'); pick.append(h('i'), h('span', '', item))
    const line = ([k, v]) => { const r = h('div', 'ap-line'); r.append(h('b', '', String(k)), h('span', '', String(v))); return r }
    const lines = Array.isArray(dg.lines) ? dg.lines : a.env ? [['Environment', a.env]] : []
    const foot = h('div', 'ap-foot')
    const start = h('span', 'ap-start', dg.button || 'OK')
    const cursor = mkCursor()
    const wrap = h('span', 'ap-startwrap'); wrap.append(start, cursor)
    foot.append(wrap)
    dlg.append(pick, ...lines.slice(0, 2).filter((l) => Array.isArray(l)).map(line), foot)
    const pad = h('div', 'ap-pad'); pad.append(tbl); s1.append(pad)
    s1.append(h('div', 'ap-scrim'), dlg)
    // The detail page: title and status chip, cards (they appear), timeline (rows appear)
    const s2 = screen('detail')
    s2.append(chrome(dt.tab))
    const head = h('div', 'ap-title')
    const chip = h('span', 'ap-chip'); const chipText = h('span'); chip.append(h('i'), chipText)
    head.append(h('b', '', dt.title || item), chip)
    const body = h('div', 'ap-body')
    const empty = String(dt.empty || 'Nothing yet')
    const none = h('div', 'ap-none', empty)
    body.append(none)
    const cards = (dt.cards || a.findings || []).slice(0, 2).map((f) => { const c = h('div', 'ap-card'); c.title = f.sev || ''; c.append(h('i', `ap-sev ${String(f.sev || '').toLowerCase()}`), h('span', 'ap-ctitle', f.title)); body.append(c); return c })
    const tl = h('div', 'ap-tl')
    const rowsT = (dt.timeline || a.timeline || []).map((t) => { const r = h('div', 'ap-ev'); r.append(h('i'), h('span', '', t)); tl.append(r); return r })
    body.append(tl)
    // Its two other panes (a beat's `pane`): the live picture (`picture`: what it says under it, e.g. "connecting…"),
    // and the chat (`chat`: how many of the messages [{ from: 'me' | 'them', text }] are there, the last two in
    // view; `typing`: what is in the message box).
    const desk = h('div', 'ap-pic')
    const deskWin = h('div', 'ap-picwin'); deskWin.append(h('i'), h('b'), h('b'))
    const picNote = String(dt.picture || 'live view')
    const deskNote = h('span', 'ap-picnote', picNote)
    desk.append(deskWin, deskNote)
    const chatPane = h('div', 'ap-chat')
    const msgs = (dt.chat || a.chat || []).map((m) => { const d = h('div', `ap-msg ${m.from === 'me' || m.from === 'you' ? 'me' : 'them'}`, m.text); chatPane.append(d); return d })
    const placeholder = String(dt.placeholder || 'Write a message…')
    const box = h('div', 'ap-box', placeholder)
    chatPane.append(box)
    s2.append(head, body, desk, chatPane)
    // Any other page (`pages: { name: { tab, title, chip?, rows: [[label, value]], banner?, button? } }`), shown by
    // `screen: name`: `rows` of them are there (all when not set), `hiRow` is the one just changed, `banner` shows its
    // notice, a beat's `click` presses its button.
    const pages = Object.entries(obj(a.pages)).map(([name, p]) => {
      const s = screen(name, 'ap-page')
      s.append(chrome(p.tab))
      const hd = h('div', 'ap-title'); hd.append(h('b', '', p.title || name))
      if (p.chip) { const c = h('span', `ap-chip ${TONE_OF[String(p.chip).toLowerCase()] || (TONES.includes(p.tone) ? p.tone : 'neutral')}`); c.append(h('i'), h('span', '', p.chip)); hd.append(c) }
      const bd = h('div', 'ap-pagebody')
      const banner = h('div', 'ap-banner', p.banner || '')
      bd.append(banner)
      const rows = (p.rows || []).slice(0, 4).map(([k, v]) => { const r = h('div', 'ap-row'); r.append(h('b', '', k), h('span', '', v)); bd.append(r); return r })
      let cur
      if (p.button) { const btn = h('span', 'ap-start', p.button); cur = mkCursor(); const w = h('span', 'ap-startwrap'); w.append(btn, cur); const f = h('div', 'ap-foot'); f.append(w); bd.append(f) }
      s.append(hd, bd)
      return { s, rows, banner, cur }
    })
    // The sign-in page: logo, title, one button; `notice` (or `ended`): its notice; `redirecting`: the button after
    // it was pressed.
    const s3 = screen('signin', 'ap-signinpage')
    const provider = sg.provider || a.provider || ''
    const note = h('div', 'ap-notice', sg.notice || 'Your session ended')
    const signin = h('span', 'ap-signin')
    const cursor3 = mkCursor()
    const swrap = h('span', 'ap-signwrap'); swrap.append(signin, cursor3)
    s3.append(mkLogo('big'), h('div', 'ap-stitle', sg.title || `Sign in to ${brand}`), note, swrap)
    const signText = sg.button || (provider ? `Sign in with ${provider}` : 'Sign in')
    e.append(s1, s2, s3, ...pages.map((p) => p.s))
    return {
      el: e,
      apply(st, fwd, beat) {
        const want = st.screen || a.screen || 'dialog'
        const scr = SCREEN_ALIAS[want] || want
        // The detail page: its status, how many cards and timeline rows are there, which one just arrived.
        const status = String(st.status || dt.status || a.status || 'New')
        const tone = st.tone || dt.tone || TONE_OF[status.toLowerCase()] || 'neutral'
        chipText.textContent = status
        chip.className = `ap-chip ${TONES.includes(tone) ? tone : 'neutral'}`
        const nf = st.cards !== undefined ? st.cards : st.findings || 0, ne = st.events || 0
        const newCard = st.newCard !== undefined ? st.newCard : st.newFinding
        none.classList.toggle('off', nf > 0)
        cards.forEach((c, i) => { c.classList.toggle('on', i < nf); c.classList.toggle('new', newCard === i) })
        // The last rows that are there (a longer timeline scrolls in the app): three, two under two cards.
        const keep = nf >= 2 && cards.length >= 2 ? 2 : 3
        rowsT.forEach((r, i) => { r.classList.toggle('on', i < ne && i >= ne - keep); r.classList.toggle('new', st.newEvent === i) })
        for (const s of [s1, s2, s3, ...pages.map((p) => p.s)]) s.classList.toggle('on', s.dataset.screen === scr)
        s2.dataset.pane = st.pane === 'desktop' ? 'picture' : st.pane || ''
        deskNote.textContent = st.picture || st.desktop || picNote
        const nc = st.chat || 0
        msgs.forEach((m, i) => { m.classList.toggle('on', i < nc && i >= nc - 2); m.classList.toggle('new', st.newChat === i) })
        box.textContent = st.typing || placeholder
        box.classList.toggle('typed', !!st.typing)
        for (const p of pages) {
          p.rows.forEach((r, i) => { r.classList.toggle('on', st.rows === undefined || i < st.rows); r.classList.toggle('hi', st.hiRow === i) })
          p.banner.classList.toggle('on', !!st.banner)
        }
        note.classList.toggle('on', !!(st.notice || st.ended))
        signin.textContent = st.redirecting ? `Redirecting to ${provider || 'the sign-in provider'}…` : signText
        signin.classList.toggle('busy', !!st.redirecting)
        const click = fwd && beat.click
        e.classList.toggle('clicking', !!click)
        start.classList.toggle('busy', !!st.busy && !click)
        e.classList.remove('clicked')
        if (click) { void cursor.getBoundingClientRect(); void cursor3.getBoundingClientRect(); for (const p of pages) if (p.cur) void p.cur.getBoundingClientRect(); e.classList.add('clicked') }
      },
    }
  }

  /** A service: the function at work and what it does, ticked off one by one. */
  function serviceActor(a) {
    const e = frame(a)
    const body = h('div', 'scn-body')
    if (a.fn) body.append(h('code', 'scn-fn', a.fn))
    const checks = (a.checks || []).map((c) => { const r = h('div', 'scn-check'); r.append(h('i'), h('span', '', c)); body.append(r); return r })
    e.append(body)
    return { el: e, apply(st) { checks.forEach((c, i) => c.classList.toggle('ticked', i < (st.done || 0))) } }
  }

  /** A table / collection: rows; `show` of them are there, row `hi` is the one just written. */
  function tableActor(a) {
    const e = frame(a)
    const body = h('div', 'scn-rows')
    const rows = (a.rows || []).map((r) => {
      const d = h('div', `scn-row${r.old ? ' old' : ''}`)
      d.append(h('code', '', r.id))
      d.chips = (cs) => { const k = cs.join('|'); if (d.dataset.chips === k) return; d.dataset.chips = k; while (d.children.length > 1) d.lastChild.remove(); for (const c of cs) d.append(h('span', `scn-pill${c === 'queued' || c === 'failed' ? ' warn' : c === 'starting' || c === 'running' ? ' live' : ''}`, c)) }
      d.chips(r.chips || [])
      body.append(d)
      return d
    })
    e.append(body)
    const base = (a.rows || []).filter((r) => r.old).length
    // `chips: { rowIndex: [...] }`: what a row says now (its status changed).
    return { el: e, apply(st) { rows.forEach((r, i) => { r.classList.toggle('on', i < base + (st.show || 0)); r.classList.toggle('hi', st.hi === i); r.chips((st.chips && st.chips[i]) || a.rows[i].chips || []) }) } }
  }

  /** A cluster namespace: pods; a `ghost` pod is not there yet; `mark` points at one. */
  function clusterActor(a) {
    const e = frame(a)
    const body = h('div', 'scn-pods')
    const mk = (into) => (p) => {
      const d = h('div', `scn-pod${p.ghost ? ' ghost' : ''}`)
      const note = h('em', '', p.note || '')
      d.append(h('span', '', p.label), note)
      d.made = (on) => { d.classList.toggle('made', on); note.textContent = on ? (p.madeNote || '') : (p.note || '') }
      // `gone: [i]`: a pod that was there and is not any more (stopped, evicted, replaced).
      d.gone = (on) => { d.classList.toggle('gone', on); if (on) note.textContent = p.goneNote || 'gone' }
      into.append(d)
      return d
    }
    const pods = (a.pods || []).map(mk(body))
    e.append(body)
    // `inner`: one cluster inside this one (a virtual cluster in a namespace): { label, sub?, ghost?, pods }. A ghost
    // one is not there until a beat sets `inner: true`; `innerMade` / `innerMark` are `made` / `mark` for its pods.
    let inner, innerPods = []
    if (a.inner) {
      inner = h('div', `scn-inner${pods.length ? '' : ' alone'}`)
      const il = h('div', 'scn-inner-label')
      il.append(h('b', '', a.inner.label || 'cluster'))
      if (a.inner.sub) il.append(h('span', '', ` · ${a.inner.sub}`))
      const ib = h('div', 'scn-inner-pods')
      innerPods = (a.inner.pods || []).map(mk(ib))
      inner.append(il, ib)
      e.append(inner)
    }
    // `made: [i]`: ghost pods that exist now.
    return {
      el: e,
      apply(st) {
        pods.forEach((p, i) => { p.classList.toggle('mark', st.mark === i); p.made((st.made || []).includes(i)); p.gone((st.gone || []).includes(i)) })
        if (inner) inner.classList.toggle('there', !a.inner.ghost || !!st.inner)
        innerPods.forEach((p, i) => { p.classList.toggle('mark', st.innerMark === i); p.made((st.innerMade || []).includes(i)); p.gone((st.innerGone || []).includes(i)) })
      },
    }
  }

  /** A web page in a browser: a small shop (`title`), two `products`, each with a `button`, and a cart (`cart`).
   *  `click`: the first product's button is pressed; `flash`: a screenshot is taken; `mark`: a highlight on the cart
   *  with its `markLabel`. */
  function browserActor(a) {
    const e = frame({ ...a, label: a.label || 'Browser' })
    const win = h('div', 'br-win')
    // `lock`: 'ok' (a padlock: the certificate is trusted) or 'warn' ("Not secure"), before the address.
    const lock = h('span', 'br-lock')
    const bar = h('div', 'br-bar'); const urlw = h('span', 'br-url'); urlw.append(lock, h('span', 'br-addr', a.url || 'http://localhost:8080')); bar.append(urlw)
    const top = h('div', 'br-top')
    const cartw = h('span', 'br-cartw')
    const mark = h('span', 'br-mark'); mark.append(h('span', '', a.markLabel || 'Bug'))
    cartw.append(h('span', 'br-cart', a.cart || 'Cart 0'), mark)
    top.append(h('b', '', a.title || a.shop || 'Shop'), cartw)
    const grid = h('div', 'br-grid')
    const cursor = svg('svg', { viewBox: '0 0 20 24', class: 'br-cursor' })
    cursor.append(svg('path', { d: 'M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.7 L9.6 13 L15.5 13 Z', fill: '#fff', stroke: '#000', 'stroke-width': 1.2 }))
    let btn
    for (const p of (a.products || ['Product 1', 'Product 2']).slice(0, 2)) {
      const name = Array.isArray(p) ? p[0] : p
      const c = h('div', 'br-card'); const b = h('span', 'br-btn', a.button || 'Add to cart')
      const bw = h('span', 'br-btnw'); bw.append(b)
      if (!btn) { btn = b; bw.append(cursor) }
      c.append(h('div', 'br-img'), h('div', 'br-name', name), bw); grid.append(c)
    }
    const flash = h('div', 'br-flash')
    win.append(bar, top, grid, flash)
    e.append(win)
    return {
      el: e,
      apply(st, fwd, beat) {
        e.classList.remove('clicking')
        btn.classList.toggle('pressed', !!st.click)
        cursor.classList.toggle('at', !!st.click)
        if (fwd && beat.click === a.id) { void cursor.getBoundingClientRect(); e.classList.add('clicking') }
        mark.classList.toggle('on', !!st.mark)
        const lk = st.lock || a.lock || ''
        lock.className = `br-lock ${lk}`
        lock.textContent = lk === 'warn' ? 'Not secure' : ''
        if (lk === 'ok') { const g = svg('svg', { viewBox: '0 0 12 14', class: 'br-lockico' }); g.append(svg('path', { d: 'M3.2 6V4.2a2.8 2.8 0 0 1 5.6 0V6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }), svg('rect', { x: 1.5, y: 6, width: 9, height: 7, rx: 1.4, fill: 'currentColor' })); lock.append(g) }
        flash.classList.remove('go')
        if (fwd && beat.flash === a.id) { void flash.getBoundingClientRect(); flash.classList.add('go') }
      },
    }
  }

  /** A terminal: `lines`, each a command ("$ npm test") or a line it printed; `show` of them are there (the
   *  last six in view), line `hi` is the one just printed. Dark in every theme, like the app window. Keep a line to
   *  about 36 characters: a longer one is cut. */
  function terminalActor(a) {
    const e = frame({ ...a, label: a.label || 'Terminal' })
    const win = h('div', 'tm-win')
    const lines = (a.lines || []).map((t) => {
      const s = String(t), cmd = s.startsWith('$ ')
      const d = h('div', `tm-line${cmd ? ' cmd' : ''}`)
      if (cmd) d.append(h('i', '', '$'))
      d.append(h('span', '', cmd ? s.slice(2) : s))
      win.append(d)
      return d
    })
    e.append(win)
    return { el: e, apply(st) { const n = st.show || 0; lines.forEach((l, i) => { l.classList.toggle('on', i < n && i >= n - 6); l.classList.toggle('hi', st.hi === i) }) } }
  }

  /** A file (or a folder: its entries as lines): `lines` as they are in it, at most eight in view; `from`: the number
   *  of its first line (numbers are shown then). All of it is there unless a beat sets `show`; `hi`: the line (or
   *  [first, last]) the beat is about; `text: { i: "…" }`: lines that read differently now (marked as changed). Keep a
   *  line to about 34 characters: a longer one is cut. */
  function fileActor(a) {
    const e = frame({ ...a, label: a.label || 'file' })
    const win = h('div', 'fl-win')
    const lines = (a.lines || []).map((t, i) => {
      const d = h('div', 'fl-line')
      if (a.from) d.append(h('i', '', String(a.from + i)))
      const tx = h('span', '', String(t))
      d.append(tx)
      d.say = (v) => { const now = v === undefined ? String(t) : String(v); if (tx.textContent !== now) tx.textContent = now; d.classList.toggle('changed', v !== undefined) }
      win.append(d)
      return d
    })
    e.append(win)
    return {
      el: e,
      apply(st) {
        const n = st.show === undefined ? lines.length : st.show
        const [h0, h1] = Array.isArray(st.hi) ? st.hi : [st.hi, st.hi]
        lines.forEach((l, i) => { l.classList.toggle('on', i < n && i >= Math.max(0, n - 8)); l.classList.toggle('hi', h0 !== undefined && i >= h0 && i <= h1); l.say(st.text ? st.text[i] : undefined) })
      },
    }
  }

  /** A conversation: `messages` [{ from: 'me' | 'them', text, tool? }]; `show` of them are there (the last four in
   *  view), `hi` the one just said. `tool`: a tool call or its result (set in the code font). For a coding agent and
   *  what it calls, or a person and a model. A message is one line, about 34 characters. */
  function chatActor(a) {
    const e = frame({ ...a, label: a.label || 'Chat' })
    const win = h('div', 'ch-win')
    const msgs = (a.messages || []).map((m) => { const d = h('div', `ch-msg ${m.from === 'me' ? 'me' : 'them'}${m.tool ? ' tool' : ''}`, m.text); win.append(d); return d })
    e.append(win)
    return { el: e, apply(st) { const n = st.show || 0; msgs.forEach((m, i) => { m.classList.toggle('on', i < n && i >= n - 4); m.classList.toggle('hi', st.hi === i) }) } }
  }

  /** A queue or an in-memory bus: `slots` places (at most 8 drawn; `cap` says the real number, e.g. "256 slots");
   *  `fill` of them are taken; `drop`: one more arrived and did not fit; `note`: what it says underneath. */
  function queueActor(a) {
    const e = frame(a)
    const row = h('div', 'qu-row')
    const slots = Array.from({ length: Math.min(8, a.slots || 6) }, () => { const d = h('i'); row.append(d); return d })
    const drop = h('span', 'qu-drop', 'dropped')
    const note = h('div', 'qu-note', a.cap || '')
    e.append(row, drop, note)
    return { el: e, apply(st) { slots.forEach((s, i) => { s.classList.toggle('on', i < (st.fill || 0)); s.classList.toggle('new', st.fill !== undefined && i === st.fill - 1 && !st.drop) }); drop.classList.toggle('on', !!st.drop); note.textContent = st.note || a.cap || '' } }
  }

  /** A limit and how much of it is taken: `max` (a number) in `unit` ("GiB", "workers"); `used` of it is taken,
   *  `want`: what is being asked for on top (drawn after `used`; red when it does not fit). `note`: what it says
   *  underneath (else "12 of 16 GiB in use"). */
  function gaugeActor(a) {
    const e = frame(a)
    const bar = h('div', 'ga-bar')
    const used = h('i', 'ga-used'), want = h('i', 'ga-want')
    bar.append(used, want)
    const note = h('div', 'ga-note')
    e.append(bar, note)
    const max = a.max || 1
    return {
      el: e,
      apply(st) {
        const u = st.used === undefined ? (a.used || 0) : st.used, w = st.want || 0
        used.style.width = `${Math.min(100, 100 * u / max)}%`
        want.style.width = `${Math.max(0, Math.min(100 - 100 * u / max, 100 * w / max))}%`
        want.classList.toggle('over', u + w > max)
        want.classList.toggle('on', w > 0)
        note.textContent = st.note || `${u} of ${max} ${a.unit || ''} in use${w ? (u + w > max ? `, ${w} more does not fit` : `, ${w} more fits`) : ''}`
      },
    }
  }

  const MAKE = { gauge: gaugeActor, browser: browserActor, app: appActor, console: appActor, service: serviceActor, table: tableActor, cluster: clusterActor, terminal: terminalActor, file: fileActor, chat: chatActor, queue: queueActor }

  // ---------- the player ----------

  /** opts: { onBeat(i), onClose(), onNextStep?(), height? }. `onNextStep`: at the last beat › becomes "Next step ›". */
  function create(opts) {
    opts = opts || {}
    const root = h('div', 'scn')
    root.tabIndex = 0
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', 'Animation of this step (← → beats, Esc: map)')
    const bar = h('div', 'scn-bar')
    const prev = h('button', 'icon scn-prev', '‹'), next = h('button', 'icon scn-next', '›'), pos = h('span', 'scn-pos')
    prev.title = 'Previous (←)'
    // The beat's file when it is not the step's: muted, next to the counter.
    const file = h('span', 'scn-file')
    const close = h('button', 'link scn-close', 'Map')
    close.title = 'Back to the map (Esc)'
    bar.append(prev, pos, next, file, h('span', 'scn-space'), close)
    const view = h('div', 'scn-view')
    const world = h('div', 'scn-world')
    view.append(world)
    const cap = h('p', 'scn-cap')
    cap.setAttribute('aria-live', 'polite')
    // No example under the caption (less clutter): a beat's example is at its code line, in the editor.
    // The beat's line with a few lines around it (the eyes stay on the animation): filled by `code()` once the
    // extension has found the line; shown only where there is room (the stylesheet).
    const codeEl = h('div', 'scn-code')
    codeEl.hidden = true
    root.append(bar, view, cap, codeEl)
    // Colours that read as code in any theme (the panel can't have the editor's own): comments, strings, numbers,
    // keywords and called names, by one pattern for every language (a line at a time, so a block comment's inner
    // lines stay plain). `hash`: # starts a comment in this file.
    const KEYWORDS = new Set('func function return if else for while switch case default break continue go defer var const let type struct interface import export from package class extends new async await try catch finally throw range map chan select def in of not and or is None True False true false nil null undefined this self'.split(' '))
    function paintCode(into, text, hash) {
      const re = /(\/\/.*$|\/\*.*?(?:\*\/|$))|(#.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`[^`]*`?)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g
      let at = 0, m
      while ((m = re.exec(text))) {
        let cls = m[1] ? 'c' : m[2] ? (hash ? 'c' : '') : m[3] ? 's' : m[4] ? 'n' : KEYWORDS.has(m[5]) ? 'k' : text[re.lastIndex] === '(' ? 'f' : ''
        // A # that is no comment here: only the sign is skipped, the rest is read on.
        if (m[2] && !hash) { re.lastIndex = m.index + 1; continue }
        if (!cls) continue
        if (m.index > at) into.append(text.slice(at, m.index))
        into.append(h('span', `scn-tk-${cls}`, m[0]))
        at = re.lastIndex
      }
      if (at < text.length) into.append(text.slice(at))
    }
    function showCode(c) {
      codeEl.textContent = ''
      codeEl.hidden = !c || !c.lines || !c.lines.length
      if (codeEl.hidden) return
      const head = h('div', 'scn-code-file', `${String(c.file).split('/').pop()}:${c.line}`)
      head.title = c.file
      codeEl.append(head)
      // Without the indentation they share: the part that matters stays in view.
      const hash = /\.(py|sh|ya?ml|toml|rb)$|Dockerfile|Makefile/.test(String(c.file))
      const ls = c.lines.map((t) => String(t).replace(/\t/g, '  '))
      const cut = Math.min(...ls.filter((t) => t.trim()).map((t) => t.length - t.trimStart().length), 99)
      ls.forEach((t, k) => {
        const row = h('div', `scn-code-line${c.from + k === c.line ? ' on' : ''}`)
        const tx = h('span', 'scn-code-t')
        paintCode(tx, t.trim() ? t.slice(cut) : '', hash)
        row.append(h('span', 'scn-code-n', String(c.from + k)), tx)
        codeEl.append(row)
      })
    }

    let scene, key = '', beat = 0, actors = {}, rects = {}, W = 0, H = 0, packet, wires = [], timer = 0, stepFile = '', hasNext = false, size = ''

    function build() {
      world.textContent = ''
      actors = {}; rects = {}; wires = []
      const cols = []
      for (const a of scene.actors || []) { if (!MAKE[a.type]) continue; (cols[a.col || 0] = cols[a.col || 0] || []).push(a) }
      let x = 0
      H = 0
      for (const col of cols) {
        if (!col) continue
        let y = 0, w = 0
        for (const a of col) {
          const [aw, ah] = sizeOf(a)
          rects[a.id] = { x, y, w: aw, h: ah }
          y += ah + ROW_GAP; w = Math.max(w, aw)
        }
        H = Math.max(H, y - ROW_GAP)
        x += w + COL_GAP
      }
      W = x - COL_GAP
      const lines = svg('svg', { class: 'scn-wires', width: W, height: H })
      world.append(lines)
      for (const [f, t] of scene.wires || []) {
        const a = rects[f], b = rects[t]
        if (!a || !b) continue
        const [l, r] = a.x < b.x ? [a, b] : [b, a]
        const small = l.h <= r.h ? l : r
        const y = small.y + small.h / 2
        const ln = svg('line', { x1: l.x + l.w, y1: y, x2: r.x, y2: y })
        lines.append(ln)
        wires.push({ f, t, y, x1: l.x + l.w, x2: r.x, ln })
      }
      for (const a of scene.actors || []) {
        const r = rects[a.id]
        if (!r) continue
        const act = MAKE[a.type](a)
        Object.assign(act.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
        world.append(act.el)
        actors[a.id] = act
      }
      packet = h('div', 'scn-packet')
      // Once it has flown it stays gone: a re-render re-inserts the scene, which would replay the animation.
      packet.addEventListener('animationend', () => { packet.className = 'scn-packet' })
      world.append(packet)
      world.style.width = `${W}px`
      world.style.height = `${H}px`
    }

    const stateAt = (i) => {
      const st = {}
      for (let k = 0; k <= i; k++) { const s = scene.beats[k].set || {}; for (const id in s) st[id] = { ...(st[id] || {}), ...s[id] } }
      return st
    }

    /** The actor a beat looks at: its own focus, else (old "all" beats) the last one looked at before, else the next. */
    function focusOf(i) {
      for (let k = i; k >= 0; k--) if (rects[scene.beats[k].focus]) return scene.beats[k].focus
      for (let k = i + 1; k < scene.beats.length; k++) if (rects[scene.beats[k].focus]) return scene.beats[k].focus
      return Object.keys(rects)[0]
    }

    function camera() {
      const vw = view.clientWidth, vh = view.clientHeight
      if (!vw || !vh || !scene) return
      const r = rects[focusOf(beat)]
      if (!r) return
      const s = Math.min(vw / (r.w + 56), vh / (r.h + 36), 2.4)
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2
      world.style.transform = `translate(${vw / 2 - cx * s}px, ${vh / 2 - cy * s}px) scale(${s})`
    }

    function layout() {
      const vw = view.clientWidth
      if (!vw) return
      // Tall enough for one actor close up; never most of the window.
      view.style.height = `${opts.height ? opts.height : Math.round(Math.max(220, Math.min(vw * 0.74, window.innerHeight * 0.52, 560)))}px`
      // A pill in flight when the size changes would end wherever the old camera put it.
      const sz = `${vw}x${view.clientHeight}`
      if (size && sz !== size && packet) packet.className = 'scn-packet'
      size = sz
      camera()
    }

    /** A pill from the sender into the receiver: it starts inside the sender and ends just inside the receiver's
     *  border, never resting on a border, then fades. */
    function sendPacket(p) {
      const w = wires.find((x) => (x.f === p.from && x.t === p.to) || (x.f === p.to && x.t === p.from))
      if (!w || !rects[p.from] || !rects[p.to]) return
      const ltr = rects[p.from].x < rects[p.to].x
      packet.textContent = p.label
      packet.className = 'scn-packet'
      const half = packet.offsetWidth / 2 + 8
      const a = ltr ? w.x1 - half : w.x2 + half
      const z = ltr ? w.x2 + half : w.x1 - half
      packet.style.transform = `translate(${a}px, ${w.y}px) translate(-50%, -50%)`
      void packet.getBoundingClientRect()
      packet.className = 'scn-packet go'
      packet.style.transform = `translate(${z}px, ${w.y}px) translate(-50%, -50%)`
      for (const x of wires) x.ln.classList.toggle('lit', x === w)
    }

    const base = (f) => String(f || '').split('/').pop()
    function apply(fwd) {
      const b = scene.beats[beat]
      const st = stateAt(beat)
      const focus = focusOf(beat)
      for (const id in actors) {
        actors[id].apply(st[id] || {}, fwd, b)
        actors[id].el.classList.toggle('dim', id !== focus && !(b.packet && fwd && id === b.packet.from))
      }
      packet.className = 'scn-packet'
      for (const x of wires) x.ln.classList.remove('lit')
      if (b.packet && fwd) sendPacket(b.packet)
      cap.textContent = ''
      cap.append(h('span', '', b.caption || ''))
      if (b.muted) cap.append(h('span', 'scn-muted', ` ${b.muted}`))
      pos.textContent = `${beat + 1} / ${scene.beats.length}`
      // A beat without code shows none; one with code keeps the last lines until its own arrive (no flicker).
      if (!b.code) showCode(undefined)
      const f = b.code && b.code.file
      const other = !!f && !!stepFile && f !== stepFile
      file.textContent = other ? base(f) : ''
      file.title = other ? f : ''
      file.hidden = !other
      const last = beat === scene.beats.length - 1
      // Never disable or hide the button that has the focus: the focus would drop to the page.
      if (root.contains(document.activeElement) && document.activeElement !== root && ((beat === 0 && document.activeElement === prev) || (last && document.activeElement === next && !hasNext))) root.focus({ preventScroll: true })
      prev.disabled = beat === 0
      // At the last beat › walks on to the next step, the animation still on; on the last step it is not there.
      const toStep = last && hasNext
      next.textContent = toStep ? 'Next step ›' : '›'
      next.className = toStep ? 'link scn-next step' : 'icon scn-next'
      next.title = toStep ? 'Next step' : 'Next (→)'
      next.hidden = last && !hasNext
      next.disabled = false
      camera()
    }

    function go(i, quiet) {
      if (!scene) return
      const n = Math.max(0, Math.min(scene.beats.length - 1, i))
      const fwd = n === beat + 1
      if (n === beat && !quiet) return
      beat = n
      apply(fwd)
      if (opts.onBeat) opts.onBeat(beat)
    }

    prev.onclick = () => go(beat - 1)
    next.onclick = () => { if (scene && beat === scene.beats.length - 1) { if (hasNext && opts.onNextStep) opts.onNextStep() } else go(beat + 1) }
    close.onclick = () => opts.onClose && opts.onClose()
    root.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(beat + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(beat - 1) }
      else if (e.key === 'Home' && scene) { e.preventDefault(); e.stopPropagation(); go(0) }
      else if (e.key === 'End' && scene) { e.preventDefault(); e.stopPropagation(); go(scene.beats.length - 1) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (opts.onClose) opts.onClose() }
    })

    return {
      el: root,
      get beat() { return beat },
      /** The current beat's line and the lines around it: { file, line, from, lines } (numbers 1-based), or nothing. */
      code(c) { showCode(c) },
      get count() { return scene ? scene.beats.length : 0 },
      /** Shows a scene; the same key again keeps the beat (a re-render), another starts at `o.beat` (or its first).
       *  o: { file: the step's file (a beat in another file names it), next: there is a next step, beat }. */
      show(s, k, o) {
        o = o || {}
        const same = k === key && !!scene
        stepFile = o.file || ''
        const had = hasNext
        hasNext = !!o.next
        if (same) { if (had !== hasNext) apply(false); return }
        clearTimeout(timer)
        scene = s; key = k
        showCode(undefined)
        beat = Math.max(0, Math.min(s.beats.length - 1, o.beat || 0))
        build()
        apply(true)
        if (opts.onBeat) opts.onBeat(beat)
      },
      go,
      layout,
      /** The keys work at once. */
      focus() { root.focus({ preventScroll: true }) },
      /** From the first beat again, as if just opened. */
      restart() { if (scene) { beat = 0; apply(true); if (opts.onBeat) opts.onBeat(0) } },
      /** Plays every beat once, each held long enough to read (videos). */
      play(done, hold) {
        const step = () => {
          const b = scene.beats[beat]
          const ms = b.hold || (hold ? hold(b) : 1600 + 55 * ((b.caption || '').length + (b.muted || '').length) )
          timer = setTimeout(() => { if (beat >= scene.beats.length - 1) { if (done) done() } else { go(beat + 1); step() } }, ms)
        }
        step()
      },
      forget() { key = ''; scene = undefined; clearTimeout(timer) },
    }
  }

  window.JourneyScene = { create }
})()
