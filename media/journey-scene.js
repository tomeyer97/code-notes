// A step's animation: a small scene played beat by beat in place of the map. Plain DOM; styles are set
// through the CSSOM (the webview's CSP allows no inline style attributes). Needs common.js and journey-scene.css.
//
// A scene is data on a journey step (`scene`):
//   actors: [{ id, type, col, ... }]   type: one of ACTORS (below the actors: a fixed library, one look everywhere);
//             a cluster may hold one cluster inside it (`inner`: a virtual cluster in a namespace)
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
  const { el, svgEl } = window.common
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const count = (list) => (list || []).length
  const between = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const COL_GAP = 100, ROW_GAP = 20
  /** How many rows a growing list keeps in view (its newest; the box is sized for them). */
  const TERMINAL_ROWS = 6, FILE_ROWS = 8, CHAT_ROWS = 4
  /** The mouse pointer an actor draws where a beat clicks. */
  const CURSOR_PATH = 'M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.7 L9.6 13 L15.5 13 Z'

  // ---------- the actors ----------

  function frame(a) {
    const e = el('div', `scn-actor scn-${a.type}`)
    const l = el('div', 'scn-label')
    l.append(el('b', '', a.label || a.id))
    if (a.sub) l.append(el('span', '', ` · ${a.sub}`))
    e.append(l)
    return e
  }

  /** The mouse pointer (class `cls`: where it rests and how it moves). */
  function cursorEl(cls) {
    const c = svgEl('svg', { viewBox: '0 0 20 24', class: cls })
    c.append(svgEl('path', { d: CURSOR_PATH, fill: '#fff', stroke: '#000', 'stroke-width': 1.2 }))
    return c
  }

  /** A window on a list that grows: of its first `n` items the last `keep` are shown (`on`); `isHi(i)`: the item the
   *  beat is about (class `hiCls`). */
  function showLast(items, n, keep, isHi, hiCls = 'hi') {
    items.forEach((x, i) => {
      x.classList.toggle('on', i < n && i >= n - keep)
      x.classList.toggle(hiCls, isHi(i))
    })
  }

  // Older journeys name the app actor's type `console` and its screens `run-dialog`, `run-page`, `login`, with flat
  // fields (test, env, status, findings, timeline, chat, provider): all still read, as aliases and fallbacks.
  const SCREEN_ALIAS = { 'run-dialog': 'dialog', 'run-page': 'detail', login: 'signin' }
  const TONE_OF = { running: 'active', passed: 'good', failed: 'bad' }
  const TONES = ['neutral', 'active', 'good', 'bad']
  /** The detail page's chat: the last two messages in view. */
  const APP_CHAT_ROWS = 2

  /** A web app's window, in its own dark colours so it reads as an app in any editor theme. Everything it says is
   *  data: `brand`, `logo` (1-2 letters), `tabs` (≤ 3, each screen marks its own) and three built-in screens, few and
   *  large items on each:
   *    `dialog`: a list page with a dialog over it: its title, the one chosen item, ≤ 2 label/value lines, a button;
   *    `detail`: a title and a status chip, ≤ 2 cards (a severity dot each), the last timeline rows, and two
   *              panes a beat can switch to: a live picture (`picture`) and a chat;
   *    `signin`: a title, a notice, one button (`provider`).
   *  Any other page is one of `pages`. A beat's `click` presses the button of the screen that is shown.
   *  Each screen is built by its own function below: { el, cursor?, apply(st, click) }. */
  function appActor(a) {
    const brand = String(a.brand || 'App')
    const tabs = (Array.isArray(a.tabs) ? a.tabs : []).slice(0, 3).map(String)
    const e = frame({ ...a, type: 'app', label: a.label || 'Web app' })
    const app = {
      a,
      brand,
      logo: (cls) => el('span', `ap-logo${cls ? ` ${cls}` : ''}`, String(a.logo || brand.charAt(0) || 'A').slice(0, 2)),
      // The app's bar: logo, name, its tabs (the screen's own one marked).
      chrome(tab) {
        const top = el('div', 'ap-top')
        top.append(app.logo(), el('b', '', brand))
        if (tabs.length) {
          const ts = el('span', 'ap-tabs')
          for (const t of tabs) ts.append(el('span', t === tab ? 'on' : '', t))
          top.append(ts)
        }
        return top
      },
      screen(name, cls) {
        const s = el('div', `ap-win scn-screen${cls ? ` ${cls}` : ''}`)
        s.dataset.screen = name
        return s
      },
    }
    const item = String(obj(a.dialog).item || a.test || 'Item')
    const screens = [
      dialogScreen(app, obj(a.dialog), item),
      detailScreen(app, obj(a.detail), item),
      signinScreen(app, obj(a.signin)),
      ...Object.entries(obj(a.pages)).map(([name, p]) => pageScreen(app, name, p)),
    ]
    e.append(...screens.map((s) => s.el))
    return {
      el: e,
      apply(st, fwd, beat) {
        const want = st.screen || a.screen || 'dialog'
        const shown = SCREEN_ALIAS[want] || want
        const click = fwd && beat.click
        for (const s of screens) {
          s.apply(st, click)
          s.el.classList.toggle('on', s.el.dataset.screen === shown)
        }
        e.classList.toggle('clicking', !!click)
        e.classList.remove('clicked')
        // The click plays again: the cursors laid out where they start, then moved.
        if (click) {
          for (const s of screens) if (s.cursor) void s.cursor.getBoundingClientRect()
          e.classList.add('clicked')
        }
      },
    }
  }

  /** The app's `dialog` screen: the list page under a dialog with the chosen item, its lines and the button. */
  function dialogScreen(app, dg, item) {
    const s = app.screen('dialog')
    s.append(app.chrome(dg.tab))
    const table = el('div', 'ap-table')
    table.append(el('div', 'ap-tr', item))
    const dialog = el('div', 'ap-dialog')
    dialog.append(el('div', 'ap-dh', dg.title || 'Confirm'))
    const pick = el('div', 'ap-radio')
    pick.append(el('i'), el('span', '', item))
    const line = ([k, v]) => {
      const r = el('div', 'ap-line')
      r.append(el('b', '', String(k)), el('span', '', String(v)))
      return r
    }
    const lines = Array.isArray(dg.lines) ? dg.lines : app.a.env ? [['Environment', app.a.env]] : []
    const foot = el('div', 'ap-foot')
    const start = el('span', 'ap-start', dg.button || 'OK')
    const cursor = cursorEl('scn-cursor')
    const wrap = el('span', 'ap-startwrap')
    wrap.append(start, cursor)
    foot.append(wrap)
    dialog.append(pick, ...lines.slice(0, 2).filter((l) => Array.isArray(l)).map(line), foot)
    const pad = el('div', 'ap-pad')
    pad.append(table)
    s.append(pad)
    s.append(el('div', 'ap-scrim'), dialog)
    return {
      el: s,
      cursor,
      apply(st, click) { start.classList.toggle('busy', !!st.busy && !click) },
    }
  }

  /** The app's `detail` screen: title and status chip, cards (they appear), timeline (rows appear); its two other panes
   *  (a beat's `pane`): the live picture (`picture`: what it says under it, e.g. "connecting…") and the chat (`chat`:
   *  how many of the messages [{ from: 'me' | 'them', text }] are there, the last two in view; `typing`: what is in the
   *  message box). */
  function detailScreen(app, dt, item) {
    const a = app.a
    const s = app.screen('detail')
    s.append(app.chrome(dt.tab))
    const head = el('div', 'ap-title')
    const chip = el('span', 'ap-chip')
    const chipText = el('span')
    chip.append(el('i'), chipText)
    head.append(el('b', '', dt.title || item), chip)
    const body = el('div', 'ap-body')
    const none = el('div', 'ap-none', String(dt.empty || 'Nothing yet'))
    body.append(none)
    const cards = (dt.cards || a.findings || []).slice(0, 2).map((f) => {
      const c = el('div', 'ap-card')
      c.title = f.sev || ''
      c.append(el('i', `ap-sev ${String(f.sev || '').toLowerCase()}`), el('span', 'ap-ctitle', f.title))
      body.append(c)
      return c
    })
    const timeline = el('div', 'ap-tl')
    const events = (dt.timeline || a.timeline || []).map((t) => {
      const r = el('div', 'ap-ev')
      r.append(el('i'), el('span', '', t))
      timeline.append(r)
      return r
    })
    body.append(timeline)
    const picture = el('div', 'ap-pic')
    const pictureWin = el('div', 'ap-picwin')
    pictureWin.append(el('i'), el('b'), el('b'))
    const pictureText = String(dt.picture || 'live view')
    const pictureNote = el('span', 'ap-picnote', pictureText)
    picture.append(pictureWin, pictureNote)
    const chat = el('div', 'ap-chat')
    const msgs = (dt.chat || a.chat || []).map((m) => {
      const d = el('div', `ap-msg ${m.from === 'me' || m.from === 'you' ? 'me' : 'them'}`, m.text)
      chat.append(d)
      return d
    })
    const placeholder = String(dt.placeholder || 'Write a message…')
    const box = el('div', 'ap-box', placeholder)
    chat.append(box)
    s.append(head, body, picture, chat)
    return {
      el: s,
      apply(st) {
        // Its status, how many cards and timeline rows are there, which one just arrived.
        const status = String(st.status || dt.status || a.status || 'New')
        const tone = st.tone || dt.tone || TONE_OF[status.toLowerCase()] || 'neutral'
        chipText.textContent = status
        chip.className = `ap-chip ${TONES.includes(tone) ? tone : 'neutral'}`
        const shownCards = st.cards !== undefined ? st.cards : st.findings || 0
        const newCard = st.newCard !== undefined ? st.newCard : st.newFinding
        none.classList.toggle('off', shownCards > 0)
        cards.forEach((c, i) => {
          c.classList.toggle('on', i < shownCards)
          c.classList.toggle('new', newCard === i)
        })
        // The last rows that are there (a longer timeline scrolls in the app): three, two under two cards.
        const keep = shownCards >= 2 && cards.length >= 2 ? 2 : 3
        showLast(events, st.events || 0, keep, (i) => st.newEvent === i, 'new')
        s.dataset.pane = st.pane === 'desktop' ? 'picture' : st.pane || ''
        pictureNote.textContent = st.picture || st.desktop || pictureText
        showLast(msgs, st.chat || 0, APP_CHAT_ROWS, (i) => st.newChat === i, 'new')
        box.textContent = st.typing || placeholder
        box.classList.toggle('typed', !!st.typing)
      },
    }
  }

  /** The app's `signin` screen: logo, title, one button; `notice` (or `ended`): its notice; `redirecting`: the button
   *  after it was pressed. */
  function signinScreen(app, sg) {
    const s = app.screen('signin', 'ap-signinpage')
    const provider = sg.provider || app.a.provider || ''
    const note = el('div', 'ap-notice', sg.notice || 'Your session ended')
    const signin = el('span', 'ap-signin')
    const cursor = cursorEl('scn-cursor')
    const wrap = el('span', 'ap-signwrap')
    wrap.append(signin, cursor)
    s.append(app.logo('big'), el('div', 'ap-stitle', sg.title || `Sign in to ${app.brand}`), note, wrap)
    const label = sg.button || (provider ? `Sign in with ${provider}` : 'Sign in')
    return {
      el: s,
      cursor,
      apply(st) {
        note.classList.toggle('on', !!(st.notice || st.ended))
        signin.textContent = st.redirecting ? `Redirecting to ${provider || 'the sign-in provider'}…` : label
        signin.classList.toggle('busy', !!st.redirecting)
      },
    }
  }

  /** Any other page of the app (`pages: { name: { tab, title, chip?, rows: [[label, value]], banner?, button? } }`),
   *  shown by `screen: name`: `rows` of them are there (all when not set), `hiRow` is the one just changed, `banner`
   *  shows its notice, a beat's `click` presses its button. */
  function pageScreen(app, name, p) {
    const s = app.screen(name, 'ap-page')
    s.append(app.chrome(p.tab))
    const head = el('div', 'ap-title')
    head.append(el('b', '', p.title || name))
    if (p.chip) {
      const tone = TONE_OF[String(p.chip).toLowerCase()] || (TONES.includes(p.tone) ? p.tone : 'neutral')
      const c = el('span', `ap-chip ${tone}`)
      c.append(el('i'), el('span', '', p.chip))
      head.append(c)
    }
    const body = el('div', 'ap-pagebody')
    const banner = el('div', 'ap-banner', p.banner || '')
    body.append(banner)
    const rows = (p.rows || []).slice(0, 4).map(([k, v]) => {
      const r = el('div', 'ap-row')
      r.append(el('b', '', k), el('span', '', v))
      body.append(r)
      return r
    })
    let cursor
    if (p.button) {
      const button = el('span', 'ap-start', p.button)
      cursor = cursorEl('scn-cursor')
      const wrap = el('span', 'ap-startwrap')
      wrap.append(button, cursor)
      const foot = el('div', 'ap-foot')
      foot.append(wrap)
      body.append(foot)
    }
    s.append(head, body)
    return {
      el: s,
      cursor,
      apply(st) {
        rows.forEach((r, i) => {
          r.classList.toggle('on', st.rows === undefined || i < st.rows)
          r.classList.toggle('hi', st.hiRow === i)
        })
        banner.classList.toggle('on', !!st.banner)
      },
    }
  }

  /** A service: the function at work and what it does, ticked off one by one. */
  function serviceActor(a) {
    const e = frame(a)
    const body = el('div', 'scn-body')
    if (a.fn) body.append(el('code', 'scn-fn', a.fn))
    const checks = (a.checks || []).map((c) => {
      const r = el('div', 'scn-check')
      r.append(el('i'), el('span', '', c))
      body.append(r)
      return r
    })
    e.append(body)
    return {
      el: e,
      apply(st) {
        checks.forEach((c, i) => c.classList.toggle('ticked', i < (st.done || 0)))
      },
    }
  }

  /** A row's status pill: amber while waiting or failed, the accent while it runs. */
  const pillTone = (c) => (c === 'queued' || c === 'failed' ? ' warn' : c === 'starting' || c === 'running' ? ' live' : '')

  /** A table / collection: rows; `show` of them are there, row `hi` is the one just written. */
  function tableActor(a) {
    const e = frame(a)
    const body = el('div', 'scn-rows')
    const rows = (a.rows || []).map((r) => {
      const d = el('div', `scn-row${r.old ? ' old' : ''}`)
      d.append(el('code', '', r.id))
      // What the row says now: its pills, redrawn only when they change.
      d.chips = (cs) => {
        const k = cs.join('|')
        if (d.dataset.chips === k) return
        d.dataset.chips = k
        while (d.children.length > 1) d.lastChild.remove()
        for (const c of cs) d.append(el('span', `scn-pill${pillTone(c)}`, c))
      }
      d.chips(r.chips || [])
      body.append(d)
      return d
    })
    e.append(body)
    const base = (a.rows || []).filter((r) => r.old).length
    // `chips: { rowIndex: [...] }`: what a row says now (its status changed).
    return {
      el: e,
      apply(st) {
        rows.forEach((r, i) => {
          r.classList.toggle('on', i < base + (st.show || 0))
          r.classList.toggle('hi', st.hi === i)
          r.chips((st.chips && st.chips[i]) || a.rows[i].chips || [])
        })
      },
    }
  }

  /** A cluster namespace: pods; a `ghost` pod is not there yet; `mark` points at one. */
  function clusterActor(a) {
    const e = frame(a)
    const body = el('div', 'scn-pods')
    const mk = (into) => (p) => {
      const d = el('div', `scn-pod${p.ghost ? ' ghost' : ''}`)
      const note = el('em', '', p.note || '')
      d.append(el('span', '', p.label), note)
      d.made = (on) => {
        d.classList.toggle('made', on)
        note.textContent = on ? (p.madeNote || '') : (p.note || '')
      }
      // `gone: [i]`: a pod that was there and is not any more (stopped, evicted, replaced).
      d.gone = (on) => {
        d.classList.toggle('gone', on)
        if (on) note.textContent = p.goneNote || 'gone'
      }
      into.append(d)
      return d
    }
    const pods = (a.pods || []).map(mk(body))
    e.append(body)
    // `inner`: one cluster inside this one (a virtual cluster in a namespace): { label, sub?, ghost?, pods }. A ghost
    // one is not there until a beat sets `inner: true`; `innerMade` / `innerMark` are `made` / `mark` for its pods.
    let inner, innerPods = []
    if (a.inner) {
      inner = el('div', `scn-inner${pods.length ? '' : ' alone'}`)
      const il = el('div', 'scn-inner-label')
      il.append(el('b', '', a.inner.label || 'cluster'))
      if (a.inner.sub) il.append(el('span', '', ` · ${a.inner.sub}`))
      const ib = el('div', 'scn-inner-pods')
      innerPods = (a.inner.pods || []).map(mk(ib))
      inner.append(il, ib)
      e.append(inner)
    }
    // `made: [i]`: ghost pods that exist now.
    const podsAt = (list, mark, made, gone) => list.forEach((p, i) => {
      p.classList.toggle('mark', mark === i)
      p.made((made || []).includes(i))
      p.gone((gone || []).includes(i))
    })
    return {
      el: e,
      apply(st) {
        podsAt(pods, st.mark, st.made, st.gone)
        if (inner) inner.classList.toggle('there', !a.inner.ghost || !!st.inner)
        podsAt(innerPods, st.innerMark, st.innerMade, st.innerGone)
      },
    }
  }

  /** The browser's padlock: the certificate is trusted. */
  function padlockEl() {
    const g = svgEl('svg', { viewBox: '0 0 12 14', class: 'br-lockico' })
    g.append(
      svgEl('path', { d: 'M3.2 6V4.2a2.8 2.8 0 0 1 5.6 0V6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }),
      svgEl('rect', { x: 1.5, y: 6, width: 9, height: 7, rx: 1.4, fill: 'currentColor' }),
    )
    return g
  }

  /** A web page in a browser: a small shop (`title`), two `products`, each with a `button`, and a cart (`cart`).
   *  `click`: the first product's button is pressed; `flash`: a screenshot is taken; `mark`: a highlight on the cart
   *  with its `markLabel`. */
  function browserActor(a) {
    const e = frame({ ...a, label: a.label || 'Browser' })
    const win = el('div', 'br-win')
    // `lock`: 'ok' (a padlock: the certificate is trusted) or 'warn' ("Not secure"), before the address.
    const lock = el('span', 'br-lock')
    const bar = el('div', 'br-bar')
    const urlw = el('span', 'br-url')
    urlw.append(lock, el('span', 'br-addr', a.url || 'http://localhost:8080'))
    bar.append(urlw)
    const top = el('div', 'br-top')
    const cartw = el('span', 'br-cartw')
    const mark = el('span', 'br-mark')
    mark.append(el('span', '', a.markLabel || 'Bug'))
    cartw.append(el('span', 'br-cart', a.cart || 'Cart 0'), mark)
    top.append(el('b', '', a.title || a.shop || 'Shop'), cartw)
    const grid = el('div', 'br-grid')
    const cursor = cursorEl('br-cursor')
    let btn
    for (const p of (a.products || ['Product 1', 'Product 2']).slice(0, 2)) {
      const name = Array.isArray(p) ? p[0] : p
      const c = el('div', 'br-card')
      const b = el('span', 'br-btn', a.button || 'Add to cart')
      const bw = el('span', 'br-btnw')
      bw.append(b)
      if (!btn) { btn = b; bw.append(cursor) }
      c.append(el('div', 'br-img'), el('div', 'br-name', name), bw)
      grid.append(c)
    }
    const flash = el('div', 'br-flash')
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
        if (lk === 'ok') lock.append(padlockEl())
        flash.classList.remove('go')
        if (fwd && beat.flash === a.id) { void flash.getBoundingClientRect(); flash.classList.add('go') }
      },
    }
  }

  /** A terminal: `lines`, each a command ("$ npm test") or a line it printed; `show` of them are there (the
   *  last TERMINAL_ROWS in view), line `hi` is the one just printed. Dark in every theme, like the app window. Keep a
   *  line to about 36 characters: a longer one is cut. */
  function terminalActor(a) {
    const e = frame({ ...a, label: a.label || 'Terminal' })
    const win = el('div', 'tm-win')
    const lines = (a.lines || []).map((t) => {
      const s = String(t), cmd = s.startsWith('$ ')
      const d = el('div', `tm-line${cmd ? ' cmd' : ''}`)
      if (cmd) d.append(el('i', '', '$'))
      d.append(el('span', '', cmd ? s.slice(2) : s))
      win.append(d)
      return d
    })
    e.append(win)
    return {
      el: e,
      apply(st) { showLast(lines, st.show || 0, TERMINAL_ROWS, (i) => st.hi === i) },
    }
  }

  /** A file (or a folder: its entries as lines): `lines` as they are in it, at most FILE_ROWS in view; `from`: the
   *  number of its first line (numbers are shown then). All of it is there unless a beat sets `show`; `hi`: the line
   *  (or [first, last]) the beat is about; `text: { i: "…" }`: lines that read differently now (marked as changed).
   *  Keep a line to about 34 characters: a longer one is cut. */
  function fileActor(a) {
    const e = frame({ ...a, label: a.label || 'file' })
    const win = el('div', 'fl-win')
    const lines = (a.lines || []).map((t, i) => {
      const d = el('div', 'fl-line')
      if (a.from) d.append(el('i', '', String(a.from + i)))
      const tx = el('span', '', String(t))
      d.append(tx)
      d.say = (v) => {
        const now = v === undefined ? String(t) : String(v)
        if (tx.textContent !== now) tx.textContent = now
        d.classList.toggle('changed', v !== undefined)
      }
      win.append(d)
      return d
    })
    e.append(win)
    return {
      el: e,
      apply(st) {
        const [h0, h1] = Array.isArray(st.hi) ? st.hi : [st.hi, st.hi]
        showLast(lines, st.show === undefined ? lines.length : st.show, FILE_ROWS, (i) => h0 !== undefined && i >= h0 && i <= h1)
        lines.forEach((l, i) => l.say(st.text ? st.text[i] : undefined))
      },
    }
  }

  /** A conversation: `messages` [{ from: 'me' | 'them', text, tool? }]; `show` of them are there (the last CHAT_ROWS
   *  in view), `hi` the one just said. `tool`: a tool call or its result (set in the code font). For a coding agent
   *  and what it calls, or a person and a model. A message is one line, about 34 characters. */
  function chatActor(a) {
    const e = frame({ ...a, label: a.label || 'Chat' })
    const win = el('div', 'ch-win')
    const msgs = (a.messages || []).map((m) => {
      const d = el('div', `ch-msg ${m.from === 'me' ? 'me' : 'them'}${m.tool ? ' tool' : ''}`, m.text)
      win.append(d)
      return d
    })
    e.append(win)
    return {
      el: e,
      apply(st) { showLast(msgs, st.show || 0, CHAT_ROWS, (i) => st.hi === i) },
    }
  }

  /** A queue or an in-memory bus: `slots` places (at most 8 drawn; `cap` says the real number, e.g. "256 slots");
   *  `fill` of them are taken; `drop`: one more arrived and did not fit; `note`: what it says underneath. */
  function queueActor(a) {
    const e = frame(a)
    const row = el('div', 'qu-row')
    const slots = Array.from({ length: Math.min(8, a.slots || 6) }, () => {
      const d = el('i')
      row.append(d)
      return d
    })
    const drop = el('span', 'qu-drop', 'dropped')
    const note = el('div', 'qu-note', a.cap || '')
    e.append(row, drop, note)
    return {
      el: e,
      apply(st) {
        slots.forEach((s, i) => {
          s.classList.toggle('on', i < (st.fill || 0))
          s.classList.toggle('new', st.fill !== undefined && i === st.fill - 1 && !st.drop)
        })
        drop.classList.toggle('on', !!st.drop)
        note.textContent = st.note || a.cap || ''
      },
    }
  }

  /** A limit and how much of it is taken: `max` (a number) in `unit` ("GiB", "workers"); `used` of it is taken,
   *  `want`: what is being asked for on top (drawn after `used`; red when it does not fit). `note`: what it says
   *  underneath (else "12 of 16 GiB in use"). */
  function gaugeActor(a) {
    const e = frame(a)
    const bar = el('div', 'ga-bar')
    const used = el('i', 'ga-used'), want = el('i', 'ga-want')
    bar.append(used, want)
    const note = el('div', 'ga-note')
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

  /**
   * Every actor type: its builder and its box ([w, h] in scene px, for its content). Sized so that at a 400 px wide
   * scene the camera's scale is about 1 (camera(): min(vw / (w + 56), vh / (h + 36)), view ≈ 398 × 294), and every
   * text rule is at least 11.5 px: nothing on screen below 11 px. A table grows with its rows (rows never past the box);
   * a service is as tall as its checks (no empty box); a list keeps its newest rows in view.
   */
  const ACTORS = {
    app: { make: appActor, size: () => [320, 250] },
    console: { make: appActor, size: () => [320, 250] }, // the app's old name
    browser: { make: browserActor, size: () => [320, 250] },
    service: { make: serviceActor, size: (a) => [290, between(62 + (a.fn ? 32 : 0) + 25 * count(a.checks), 150, 240)] },
    table: { make: tableActor, size: (a) => [350, Math.max(150, 58 + 40 * count(a.rows))] },
    cluster: { make: clusterActor, size: (a) => [350, a.inner ? (count(a.pods) ? 126 : 50) + 122 : 140] },
    terminal: { make: terminalActor, size: (a) => [320, 66 + 22 * between(count(a.lines), 3, TERMINAL_ROWS)] },
    file: { make: fileActor, size: (a) => [320, 60 + 20 * between(count(a.lines), 3, FILE_ROWS)] },
    chat: { make: chatActor, size: (a) => [320, 58 + 36 * between(count(a.messages), 2, CHAT_ROWS)] },
    queue: { make: queueActor, size: () => [350, 132] },
    gauge: { make: gaugeActor, size: () => [350, 132] },
  }

  // ---------- the player ----------

  /** opts: { onBeat(i), onClose(), onNextStep?(), height? }. `onNextStep`: at the last beat › becomes "Next step ›". */
  function create(opts) {
    opts = opts || {}
    const root = el('div', 'scn')
    root.tabIndex = 0
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', 'Animation of this step (← → beats, Esc: map)')
    const bar = el('div', 'scn-bar')
    const prev = el('button', 'icon scn-prev', '‹'), next = el('button', 'icon scn-next', '›'), pos = el('span', 'scn-pos')
    prev.title = 'Previous (←)'
    // The beat's file when it is not the step's: muted, next to the counter.
    const file = el('span', 'scn-file')
    const close = el('button', 'link scn-close', 'Map')
    close.title = 'Back to the map (Esc)'
    bar.append(prev, pos, next, file, el('span', 'scn-space'), close)
    const view = el('div', 'scn-view')
    const world = el('div', 'scn-world')
    view.append(world)
    const cap = el('p', 'scn-cap')
    cap.setAttribute('aria-live', 'polite')
    // No example under the caption (less clutter): a beat's example is at its code line, in the editor.
    // The beat's line with a few lines around it (the eyes stay on the animation): filled by `code()` once the
    // extension has found the line; shown only where there is room (the stylesheet).
    const codeEl = el('div', 'scn-code')
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
        into.append(el('span', `scn-tk-${cls}`, m[0]))
        at = re.lastIndex
      }
      if (at < text.length) into.append(text.slice(at))
    }
    function showCode(c) {
      codeEl.textContent = ''
      codeEl.hidden = !c || !c.lines || !c.lines.length
      if (codeEl.hidden) return
      const head = el('div', 'scn-code-file', `${String(c.file).split('/').pop()}:${c.line}`)
      head.title = c.file
      codeEl.append(head)
      // Without the indentation they share: the part that matters stays in view.
      const hash = /\.(py|sh|ya?ml|toml|rb)$|Dockerfile|Makefile/.test(String(c.file))
      const ls = c.lines.map((t) => String(t).replace(/\t/g, '  '))
      const cut = Math.min(...ls.filter((t) => t.trim()).map((t) => t.length - t.trimStart().length), 99)
      ls.forEach((t, k) => {
        const row = el('div', `scn-code-line${c.from + k === c.line ? ' on' : ''}`)
        const tx = el('span', 'scn-code-t')
        paintCode(tx, t.trim() ? t.slice(cut) : '', hash)
        row.append(el('span', 'scn-code-n', String(c.from + k)), tx)
        codeEl.append(row)
      })
    }

    let scene, key = '', beat = 0, actors = {}, rects = {}, W = 0, H = 0, packet, wires = [], timer = 0, stepFile = '', hasNext = false, size = ''

    function build() {
      world.textContent = ''
      actors = {}; rects = {}; wires = []
      const cols = []
      for (const a of scene.actors || []) { if (!ACTORS[a.type]) continue; (cols[a.col || 0] = cols[a.col || 0] || []).push(a) }
      let x = 0
      H = 0
      for (const col of cols) {
        if (!col) continue
        let y = 0, w = 0
        for (const a of col) {
          const [aw, ah] = ACTORS[a.type].size(a)
          rects[a.id] = { x, y, w: aw, h: ah }
          y += ah + ROW_GAP; w = Math.max(w, aw)
        }
        H = Math.max(H, y - ROW_GAP)
        x += w + COL_GAP
      }
      W = x - COL_GAP
      const lines = svgEl('svg', { class: 'scn-wires', width: W, height: H })
      world.append(lines)
      for (const [f, t] of scene.wires || []) {
        const a = rects[f], b = rects[t]
        if (!a || !b) continue
        const [l, r] = a.x < b.x ? [a, b] : [b, a]
        const small = l.h <= r.h ? l : r
        const y = small.y + small.h / 2
        const ln = svgEl('line', { x1: l.x + l.w, y1: y, x2: r.x, y2: y })
        lines.append(ln)
        wires.push({ f, t, y, x1: l.x + l.w, x2: r.x, ln })
      }
      for (const a of scene.actors || []) {
        const r = rects[a.id]
        if (!r) continue
        const act = ACTORS[a.type].make(a)
        Object.assign(act.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
        world.append(act.el)
        actors[a.id] = act
      }
      packet = el('div', 'scn-packet')
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
      cap.append(el('span', '', b.caption || ''))
      if (b.muted) cap.append(el('span', 'scn-muted', ` ${b.muted}`))
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
