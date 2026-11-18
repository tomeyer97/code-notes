// A step animation's web-app actor (type `app`): a web app's window and its screens, in its own dark colours so it
// reads as an app in any editor theme. Needs common.js and journey-scene.js (its actor parts), loaded before it; it
// adds itself to journey-scene.js's actor types.
//
// Everything it shows is data: `brand`, `logo` (1-2 letters), `tabs` (≤ 3, each screen marks its own) and three
// built-in screens, few and large items on each:
//   `dialog`: a list page with a dialog over it: its title, the one chosen item, ≤ 2 label/value lines, a button;
//   `detail`: a title and a status chip, ≤ 2 cards (a severity dot each), the last timeline rows, and two panes a
//             beat can switch to: a live picture (`picture`) and a chat;
//   `signin`: a title, a notice, one button (`provider`).
// Any other page is one of `pages`. A beat's `click` presses the button of the screen that is shown. Each screen is
// built by its own function below: { el, cursor?, apply(st, click) }.
//
// Older journeys name the type `console` and its screens `run-dialog`, `run-page`, `login`, with flat fields (test,
// env, status, findings, timeline, chat, provider) and older beat state (findings, newFinding, desktop): all still
// read, turned into today's names once, as they come in (upgradeAppActor, upgradeAppState).
;(function () {
  const { el } = window.common
  const { frame, cursorEl, showLast, obj, ACTORS } = window.JourneyScene.parts

  const SCREEN_ALIAS = { 'run-dialog': 'dialog', 'run-page': 'detail', login: 'signin' }
  /** A status chip's tone (journey-scene.css `.ap-chip`): from its status word, or as given when it is one of TONES. */
  const TONE_OF = { running: 'active', passed: 'good', failed: 'bad' }
  const TONES = ['neutral', 'active', 'good', 'bad']
  /** The detail page's chat: the last two messages in view. */
  const APP_CHAT_ROWS = 2

  /** The tone status word `status` reads as (undefined: none). */
  const toneOf = (status) => {
    const s = String(status).toLowerCase()
    return Object.hasOwn(TONE_OF, s) ? TONE_OF[s] : undefined
  }
  /** `tone` when it is one of TONES, else 'neutral'. */
  const knownTone = (tone) => (TONES.includes(tone) ? tone : 'neutral')
  /** A screen's name, old ones as today's. */
  const screenName = (name) => (Object.hasOwn(SCREEN_ALIAS, name) ? SCREEN_ALIAS[name] : name)

  // ---------- old data in today's names ----------

  /** Actor `a` with its old flat fields moved into its screens (`dialog`, `detail`, `signin`) and its screen named as
   *  today. */
  function upgradeAppActor(a) {
    const dialog = obj(a.dialog), detail = obj(a.detail), signin = obj(a.signin)
    const lines = Array.isArray(dialog.lines) ? dialog.lines : a.env ? [['Environment', a.env]] : []
    return {
      ...a,
      screen: a.screen && screenName(a.screen),
      dialog: { ...dialog, item: dialog.item || a.test, lines },
      detail: {
        ...detail,
        status: detail.status || a.status,
        cards: detail.cards || a.findings,
        timeline: detail.timeline || a.timeline,
        chat: detail.chat || a.chat,
      },
      signin: { ...signin, provider: signin.provider || a.provider },
    }
  }

  /** A beat's state `st` of the app with its old fields as today's: `findings` / `newFinding` are `cards` /
   *  `newCard`, the `desktop` pane and text are the `picture`'s, the screen named as today. */
  function upgradeAppState(st) {
    return {
      ...st,
      screen: st.screen && screenName(st.screen),
      cards: st.cards !== undefined ? st.cards : st.findings || 0,
      newCard: st.newCard !== undefined ? st.newCard : st.newFinding,
      pane: st.pane === 'desktop' ? 'picture' : st.pane,
      picture: st.picture || st.desktop,
    }
  }

  // ---------- the window ----------

  /** The app actor: its window, its screens, the one a beat shows. */
  function appActor(old) {
    const a = upgradeAppActor(old)
    const brand = String(a.brand || 'App')
    const tabs = (Array.isArray(a.tabs) ? a.tabs : []).slice(0, 3).map(String)
    const e = frame({ ...a, type: 'app', label: a.label || 'Web app' })
    const app = {
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
    const item = String(a.dialog.item || 'Item')
    const screens = [
      dialogScreen(app, a.dialog, item),
      detailScreen(app, a.detail, item),
      signinScreen(app, a.signin),
      ...Object.entries(obj(a.pages)).map(([name, p]) => pageScreen(app, name, p)),
    ]
    e.append(...screens.map((s) => s.el))
    return {
      el: e,
      apply(oldSt, fwd, beat) {
        const st = upgradeAppState(oldSt)
        const shown = st.screen || a.screen || 'dialog'
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

  /** A button the mouse pointer clicks: the button (class `cls`, `label`) and the pointer in a wrap (`wrapCls`). */
  function clickable(cls, wrapCls, label) {
    const button = el('span', cls, label)
    const cursor = cursorEl('scn-cursor')
    const wrap = el('span', wrapCls)
    wrap.append(button, cursor)
    return { wrap, button, cursor }
  }

  // ---------- its screens ----------

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
    const foot = el('div', 'ap-foot')
    const start = clickable('ap-start', 'ap-startwrap', dg.button || 'OK')
    foot.append(start.wrap)
    dialog.append(pick, ...dg.lines.slice(0, 2).filter((l) => Array.isArray(l)).map(line), foot)
    const pad = el('div', 'ap-pad')
    pad.append(table)
    s.append(pad)
    s.append(el('div', 'ap-scrim'), dialog)
    return {
      el: s,
      cursor: start.cursor,
      apply(st, click) { start.button.classList.toggle('busy', !!st.busy && !click) },
    }
  }

  /** The app's `detail` screen: title and status chip, cards (they appear), timeline (rows appear); its two other panes
   *  (a beat's `pane`): the live picture (`picture`: what it says under it, e.g. "connecting…") and the chat (`chat`:
   *  how many of the messages [{ from: 'me' | 'them', text }] are there, the last two in view; `typing`: what is in the
   *  message box). */
  function detailScreen(app, dt, item) {
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
    const cards = (dt.cards || []).slice(0, 2).map((f) => {
      const c = el('div', 'ap-card')
      c.title = f.sev || ''
      c.append(el('i', `ap-sev ${String(f.sev || '').toLowerCase()}`), el('span', 'ap-ctitle', f.title))
      body.append(c)
      return c
    })
    const timeline = el('div', 'ap-tl')
    const events = (dt.timeline || []).map((t) => {
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
    const msgs = (dt.chat || []).map((m) => {
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
        // Its status (a tone given wins over the status word's), how many cards and timeline rows are there, which
        // one just arrived.
        const status = String(st.status || dt.status || 'New')
        chipText.textContent = status
        chip.className = `ap-chip ${knownTone(st.tone || dt.tone || toneOf(status) || 'neutral')}`
        none.classList.toggle('off', st.cards > 0)
        cards.forEach((c, i) => {
          c.classList.toggle('on', i < st.cards)
          c.classList.toggle('new', st.newCard === i)
        })
        // The last rows that are there (a longer timeline scrolls in the app): three, two under two cards.
        const keep = st.cards >= 2 && cards.length >= 2 ? 2 : 3
        showLast(events, st.events || 0, keep, (i) => st.newEvent === i, 'new')
        s.dataset.pane = st.pane || ''
        pictureNote.textContent = st.picture || pictureText
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
    const provider = sg.provider || ''
    const note = el('div', 'ap-notice', sg.notice || 'Your session ended')
    const signin = clickable('ap-signin', 'ap-signwrap')
    s.append(app.logo('big'), el('div', 'ap-stitle', sg.title || `Sign in to ${app.brand}`), note, signin.wrap)
    const label = sg.button || (provider ? `Sign in with ${provider}` : 'Sign in')
    return {
      el: s,
      cursor: signin.cursor,
      apply(st) {
        note.classList.toggle('on', !!(st.notice || st.ended))
        signin.button.textContent = st.redirecting ? `Redirecting to ${provider || 'the sign-in provider'}…` : label
        signin.button.classList.toggle('busy', !!st.redirecting)
      },
    }
  }

  /** Any other page of the app (`pages: { name: { tab, title, chip?, rows: [[label, value]], banner?, button? } }`),
   *  shown by `screen: name`: `rows` of them are there (all when not set), `hiRow` is the one just changed, `banner`
   *  shows its notice, a beat's `click` presses its button. Its chip's tone: the status word's, else `tone`. */
  function pageScreen(app, name, p) {
    const s = app.screen(name, 'ap-page')
    s.append(app.chrome(p.tab))
    const head = el('div', 'ap-title')
    head.append(el('b', '', p.title || name))
    if (p.chip) {
      const c = el('span', `ap-chip ${toneOf(p.chip) || knownTone(p.tone)}`)
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
      const start = clickable('ap-start', 'ap-startwrap', p.button)
      cursor = start.cursor
      const foot = el('div', 'ap-foot')
      foot.append(start.wrap)
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

  // The app's box is the same for every journey; `console` is its old name.
  ACTORS.app = { make: appActor, size: () => [320, 250] }
  ACTORS.console = ACTORS.app
})()
