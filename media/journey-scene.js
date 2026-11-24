// A step's animation: a small scene played beat by beat in place of the map. Plain DOM; styles are set
// through the CSSOM (the webview's CSP allows no inline style attributes); the look is journey-scene.css.
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
// The web-app actor (journey-scene-app.js) adds itself to ACTORS through `parts` when a page imports it.
import { el, svgEl, runKey, between, baseName } from './common.js'
import { showCode } from './code-paint.js'
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const count = (list) => (list || []).length
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

/** A row's status pill: amber while waiting or failed, the accent while it runs. Its own scale (`.scn-pill`): a table
 *  row's states, in the editor's colours; the app's status chips (journey-scene-app.js) are the app's. */
function pillTone(c) {
  if (c === 'queued' || c === 'failed') return ' warn'
  if (c === 'starting' || c === 'running') return ' live'
  return ''
}

/** A table / collection: rows; `show` of them are there, row `hi` is the one just written. */
function tableActor(a) {
  const e = frame(a)
  const body = el('div', 'scn-rows')
  const rows = (a.rows || []).map((r) => {
    const d = /** @type {any} */ (el('div', `scn-row${r.old ? ' old' : ''}`))
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
    const d = /** @type {any} */ (el('div', `scn-pod${p.ghost ? ' ghost' : ''}`))
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
    const d = /** @type {any} */ (el('div', 'fl-line'))
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

// The boxes' heights (scene px): a top part (the label, a header) and rows, each row as high as its rule in
// journey-scene.css says (the line-height, or the height and the gap).
/** A service: its top, its function's line (`.scn-fn`), a check (`.scn-check`); between SERVICE_MIN and SERVICE_MAX. */
const SERVICE_TOP = 62, SERVICE_FN_PX = 32, SERVICE_CHECK_PX = 25, SERVICE_MIN = 150, SERVICE_MAX = 240
/** A table: its top and a row (`.scn-row`, 38 px and the gap); at least TABLE_MIN. */
const TABLE_TOP = 58, TABLE_ROW_PX = 40, TABLE_MIN = 150
/** A cluster: alone 140; with a cluster inside it (`.scn-inner`), that part, under its own pods or alone. */
const CLUSTER_H = 140, CLUSTER_PODS_TOP = 126, CLUSTER_INNER_ALONE_TOP = 50, CLUSTER_INNER_H = 122
/** A terminal (`.tm-win` line-height), a file (`.fl-win`), a chat (`.ch-msg` and the gap): top and row. */
const TERMINAL_TOP = 66, TERMINAL_ROW_PX = 22, FILE_TOP = 60, FILE_ROW_PX = 20, CHAT_TOP = 58, CHAT_ROW_PX = 36

/**
 * Every actor type: its builder and its box ([w, h] in scene px, for its content). Sized so that at a 400 px wide
 * scene the camera's scale is about 1 (camera(): min(vw / (w + 56), vh / (h + 36)), view ≈ 398 × 294), and every
 * text rule is at least 11.5 px: nothing on screen below 11 px. A table grows with its rows (rows never past the box);
 * a service is as tall as its checks (no empty box); a list keeps its newest rows in view. The web app (`app`, old
 * name `console`) is added by journey-scene-app.js.
 */
const ACTORS = {
  browser: { make: browserActor, size: () => [320, 250] },
  service: { make: serviceActor, size: (a) => [290, serviceH(a)] },
  table: { make: tableActor, size: (a) => [350, Math.max(TABLE_MIN, TABLE_TOP + TABLE_ROW_PX * count(a.rows))] },
  cluster: { make: clusterActor, size: (a) => [350, clusterH(a)] },
  terminal: { make: terminalActor, size: (a) => [320, TERMINAL_TOP + TERMINAL_ROW_PX * rowsShown(a.lines, 3, TERMINAL_ROWS)] },
  file: { make: fileActor, size: (a) => [320, FILE_TOP + FILE_ROW_PX * rowsShown(a.lines, 3, FILE_ROWS)] },
  chat: { make: chatActor, size: (a) => [320, CHAT_TOP + CHAT_ROW_PX * rowsShown(a.messages, 2, CHAT_ROWS)] },
  queue: { make: queueActor, size: () => [350, 132] },
  gauge: { make: gaugeActor, size: () => [350, 132] },
}
/** Actor `a`'s type in ACTORS (undefined: none of them). */
const actorType = (a) => (Object.hasOwn(ACTORS, a.type) ? ACTORS[a.type] : undefined)
/** How many rows of `list` a box has room for: at least `min`, at most the `max` it keeps in view. */
function rowsShown(list, min, max) {
  return between(count(list), min, max)
}
function serviceH(a) {
  const h = SERVICE_TOP + (a.fn ? SERVICE_FN_PX : 0) + SERVICE_CHECK_PX * count(a.checks)
  return between(h, SERVICE_MIN, SERVICE_MAX)
}
function clusterH(a) {
  if (!a.inner) return CLUSTER_H
  return (count(a.pods) ? CLUSTER_PODS_TOP : CLUSTER_INNER_ALONE_TOP) + CLUSTER_INNER_H
}

// ---------- a scene's layout and beats (data in, data out) ----------

/** Where everything goes, in scene px: the actors in columns (`col`), each column top to bottom; a wire level with
 *  the middle of its smaller end. { rects: { id: { x, y, w, h } }, W, H, wires: [{ f, t, y, x1, x2 }] } */
function layoutScene(scene) {
  const cols = []
  for (const a of scene.actors || []) {
    if (!actorType(a)) continue
    ;(cols[a.col || 0] = cols[a.col || 0] || []).push(a)
  }
  const rects = Object.create(null)
  let x = 0, H = 0
  for (const col of cols) {
    if (!col) continue
    let y = 0, w = 0
    for (const a of col) {
      const [aw, ah] = actorType(a).size(a)
      rects[a.id] = { x, y, w: aw, h: ah }
      y += ah + ROW_GAP
      w = Math.max(w, aw)
    }
    H = Math.max(H, y - ROW_GAP)
    x += w + COL_GAP
  }
  const wires = []
  for (const [f, t] of scene.wires || []) {
    const a = rects[f], b = rects[t]
    if (!a || !b) continue
    const [l, r] = a.x < b.x ? [a, b] : [b, a]
    const small = l.h <= r.h ? l : r
    wires.push({ f, t, y: small.y + small.h / 2, x1: l.x + l.w, x2: r.x })
  }
  return { rects, W: x - COL_GAP, H, wires }
}

/** Every actor's state at beat `i`: every `set` up to it, merged. */
function stateAt(scene, i) {
  const st = Object.create(null)
  for (let k = 0; k <= i; k++) {
    const s = scene.beats[k].set || {}
    for (const id in s) st[id] = { ...(st[id] || {}), ...s[id] }
  }
  return st
}

/** The actor beat `i` looks at: its own focus, else (old "all" beats) the last one looked at before, else the next. */
function focusOf(scene, rects, i) {
  for (let k = i; k >= 0; k--) if (rects[scene.beats[k].focus]) return scene.beats[k].focus
  for (let k = i + 1; k < scene.beats.length; k++) if (rects[scene.beats[k].focus]) return scene.beats[k].focus
  return Object.keys(rects)[0]
}

// ---------- a request on a wire ----------

/** A pill from the sender to the receiver: it starts inside the sender and ends just before the receiver's border
 *  (never over what the receiver shows, never resting on a border), then fades. */
function sendPacket(packet, wires, rects, p) {
  const w = wires.find((x) => (x.f === p.from && x.t === p.to) || (x.f === p.to && x.t === p.from))
  if (!w || !rects[p.from] || !rects[p.to]) return
  const ltr = rects[p.from].x < rects[p.to].x
  packet.textContent = p.label
  packet.className = 'scn-packet'
  const half = packet.offsetWidth / 2 + 8
  const a = ltr ? w.x1 - half : w.x2 + half
  const z = ltr ? w.x2 - half : w.x1 + half
  packet.style.transform = `translate(${a}px, ${w.y}px) translate(-50%, -50%)`
  void packet.getBoundingClientRect()
  packet.className = 'scn-packet go'
  packet.style.transform = `translate(${z}px, ${w.y}px) translate(-50%, -50%)`
  for (const x of wires) x.ln.classList.toggle('lit', x === w)
}

// ---------- the player ----------

/** The player's elements: the bar (‹ n / N › the beat's file … Map), the view with its world, the caption, the code. */
function playerEl() {
  const root = el('div', 'scn')
  root.tabIndex = 0
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'Animation of this step (← → beats, Esc: map)')
  const bar = el('div', 'scn-bar')
  const prev = el('button', 'icon scn-prev', '‹'), next = el('button', 'icon scn-next', '›'), pos = el('span', 'scn-pos')
  // The beat as dots (up to DOTS_MAX beats): "6 / 6" next to "Next step ›" read as "step 6 of 6". The words stay for
  // screen readers (and for more beats).
  const dots = el('span', 'scn-dots')
  dots.setAttribute('aria-hidden', 'true')
  prev.title = 'Previous (←)'
  // The beat's file when it is not the step's: muted, next to the counter.
  const file = el('span', 'scn-file')
  const close = el('button', 'link scn-close', 'Map')
  close.title = 'Back to the map (Esc)'
  bar.append(prev, pos, dots, next, file, el('span', 'scn-space'), close)
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
  return { root, prev, next, pos, dots, file, close, view, world, cap, codeEl }
}
/** At most this many beats show as dots. */
const DOTS_MAX = 12


/** The camera's margin around the actor it looks at (scene px, both sides together), and its closest zoom. */
const CAMERA_PAD_W = 56, CAMERA_PAD_H = 36, CAMERA_MAX_SCALE = 2.4
/** The view: tall enough for one actor close up (VIEW_MIN_H, or VIEW_W_SHARE of its width), never most of the
 *  window (VIEW_WINDOW_SHARE of it, at most VIEW_MAX_H). */
const VIEW_MIN_H = 220, VIEW_MAX_H = 560, VIEW_W_SHARE = 0.74, VIEW_WINDOW_SHARE = 0.52
/** play(): a beat is held READ_MS, and READ_MS_PER_CHAR for each character of its caption (videos). */
const READ_MS = 1600, READ_MS_PER_CHAR = 55

/** opts: { onBeat(i, how), onClose(), onNextStep?(), height? }. `how`: 'go' when the beat was moved to (‹ ›, the keys,
 *  go()), else it came with the scene shown. `onNextStep`: at the last beat › becomes "Next step ›". */
function create(opts) {
  opts = opts || {}
  const { root, prev, next, pos, dots, file, close, view, world, cap, codeEl } = playerEl()

  /** The scene shown (a step's `scene`) and its key: the same key again keeps the beat. */
  let scene
  let key = ''
  /** The beat on screen (0-based). */
  let beat = 0
  /** The scene's actors by id ({ el, apply }) and their boxes (layoutScene). */
  let actors = Object.create(null)
  let rects = Object.create(null)
  /** The wires: { f, t, y, x1, x2, ln (its line) }. */
  let wires = []
  /** The pill that travels a wire. */
  let packet
  /** play()'s next beat. */
  let timer = 0
  /** The step's own file (a beat's code in another one names its file), and whether a next step follows. */
  let stepFile = ''
  let hasNext = false
  /** The view's size when last laid out ({ w, h }; undefined: not yet). */
  let size

  function build() {
    world.textContent = ''
    actors = Object.create(null)
    const L = layoutScene(scene)
    rects = L.rects
    const lines = svgEl('svg', { class: 'scn-wires', width: L.W, height: L.H })
    world.append(lines)
    wires = L.wires.map((w) => {
      const ln = svgEl('line', { x1: w.x1, y1: w.y, x2: w.x2, y2: w.y })
      lines.append(ln)
      return { ...w, ln }
    })
    for (const a of scene.actors || []) {
      const r = rects[a.id]
      if (!r) continue
      const act = actorType(a).make(a)
      Object.assign(act.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
      world.append(act.el)
      actors[a.id] = act
    }
    packet = el('div', 'scn-packet')
    // Once it has flown it stays gone: a re-render re-inserts the scene, which would replay the animation.
    packet.addEventListener('animationend', () => { packet.className = 'scn-packet' })
    world.append(packet)
    world.style.width = `${L.W}px`
    world.style.height = `${L.H}px`
  }

  function camera() {
    const vw = view.clientWidth, vh = view.clientHeight
    if (!vw || !vh || !scene) return
    const r = rects[focusOf(scene, rects, beat)]
    if (!r) return
    const s = Math.min(vw / (r.w + CAMERA_PAD_W), vh / (r.h + CAMERA_PAD_H), CAMERA_MAX_SCALE)
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2
    const tx = vw / 2 - cx * s, ty = vh / 2 - cy * s
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
    // A wire with an end out of view would be a stub from the box to the view's edge, joined to nothing: hidden.
    const left = -tx / s - 1, right = (vw - tx) / s + 1, top = -ty / s, bottom = (vh - ty) / s
    for (const x of wires) x.ln.classList.toggle('out', x.x1 < left || x.x2 > right || x.y < top || x.y > bottom)
  }

  function layout() {
    const vw = view.clientWidth
    if (!vw) return
    view.style.height = `${opts.height ? opts.height : viewHeight(vw)}px`
    // A pill in flight when the size changes would end wherever the old camera put it.
    const sz = { w: vw, h: view.clientHeight }
    if (size && (sz.w !== size.w || sz.h !== size.h) && packet) packet.className = 'scn-packet'
    size = sz
    camera()
  }
  /** The view's height at width `vw` (px). */
  function viewHeight(vw) {
    const h = Math.min(vw * VIEW_W_SHARE, window.innerHeight * VIEW_WINDOW_SHARE, VIEW_MAX_H)
    return Math.round(Math.max(VIEW_MIN_H, h))
  }

  function apply(fwd) {
    const b = scene.beats[beat]
    const st = stateAt(scene, beat)
    const focus = focusOf(scene, rects, beat)
    for (const id in actors) {
      actors[id].apply(st[id] || {}, fwd, b)
      actors[id].el.classList.toggle('dim', id !== focus && !(b.packet && fwd && id === b.packet.from))
    }
    packet.className = 'scn-packet'
    for (const x of wires) x.ln.classList.remove('lit')
    if (b.packet && fwd) sendPacket(packet, wires, rects, b.packet)
    cap.textContent = ''
    cap.append(el('span', '', b.caption || ''))
    if (b.muted) cap.append(el('span', 'scn-muted', ` ${b.muted}`))
    pos.textContent = `${beat + 1} / ${scene.beats.length}`
    pos.setAttribute('aria-label', `Beat ${beat + 1} of ${scene.beats.length}`)
    const asDots = scene.beats.length <= DOTS_MAX
    pos.classList.toggle('sr', asDots)
    dots.hidden = !asDots
    if (asDots) {
      dots.textContent = ''
      for (let k = 0; k < scene.beats.length; k++) dots.append(el('i', k === beat ? 'on' : k < beat ? 'past' : ''))
      dots.title = `Beat ${beat + 1} of ${scene.beats.length}`
    }
    // A beat without code shows none; one with code keeps the last lines until its own arrive (no flicker).
    if (!b.code) showCode(codeEl, undefined)
    const f = b.code && b.code.file
    const other = !!f && !!stepFile && f !== stepFile
    file.textContent = other ? baseName(f) : ''
    file.title = other ? f : ''
    file.hidden = !other
    updateNav()
    camera()
  }

  /** ‹ and › for the beat on screen. */
  function updateNav() {
    const last = beat === scene.beats.length - 1
    // Never disable or hide the button that has the focus: the focus would drop to the page.
    const focused = document.activeElement
    const losing = (beat === 0 && focused === prev) || (last && focused === next && !hasNext)
    if (root.contains(focused) && focused !== root && losing) root.focus({ preventScroll: true })
    prev.disabled = beat === 0
    // At the last beat › walks on to the next step, the animation still on; on the last step it is not there.
    const toStep = last && hasNext
    next.textContent = toStep ? 'Next step ›' : '›'
    next.className = toStep ? 'link scn-next step' : 'icon scn-next'
    next.title = toStep ? 'Next step' : 'Next (→)'
    next.hidden = last && !hasNext
    next.disabled = false
  }

  /** To beat i; `quiet`: drawn again even when it is the beat shown; `still`: without the beat's flight (a jump). */
  function go(i, quiet, still) {
    if (!scene) return
    const n = Math.max(0, Math.min(scene.beats.length - 1, i))
    const fwd = !still && n === beat + 1
    if (n === beat && !quiet) return
    beat = n
    apply(fwd)
    if (opts.onBeat) opts.onBeat(beat, 'go')
  }

  prev.onclick = () => go(beat - 1)
  next.onclick = () => {
    if (scene && beat === scene.beats.length - 1) { if (hasNext && opts.onNextStep) opts.onNextStep() }
    else go(beat + 1)
  }
  close.onclick = () => opts.onClose && opts.onClose()
  root.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    runKey(e, {
      ArrowRight: () => go(beat + 1),
      ArrowLeft: () => go(beat - 1),
      Home: !!scene && (() => go(0)),
      End: !!scene && (() => go(scene.beats.length - 1)),
      Escape: () => { if (opts.onClose) opts.onClose() },
    }, true)
  })

  return {
    el: root,
    get beat() { return beat },
    /** The current beat's line and the lines around it: { file, line, from, lines } (numbers 1-based), or nothing. */
    code(c) { showCode(codeEl, c) },
    get count() { return scene ? scene.beats.length : 0 },
    /** Shows a scene; the same key again keeps the beat (a re-render), another starts at `o.beat` (or its first).
     *  o: { file: the step's file (a beat in another file names it), next: there is a next step, beat, still: shown
     *  without its flight }. */
    show(s, k, o) {
      o = o || {}
      const same = k === key && !!scene
      stepFile = o.file || ''
      const had = hasNext
      hasNext = !!o.next
      if (same) { if (had !== hasNext) apply(false); return }
      clearTimeout(timer)
      scene = s; key = k
      showCode(codeEl, undefined)
      beat = Math.max(0, Math.min(s.beats.length - 1, o.beat || 0))
      build()
      apply(!o.still)
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
      const readMs = (b) => READ_MS + READ_MS_PER_CHAR * ((b.caption || '').length + (b.muted || '').length)
      const step = () => {
        const b = scene.beats[beat]
        const ms = b.hold || (hold ? hold(b) : readMs(b))
        timer = window.setTimeout(() => {
          if (beat < scene.beats.length - 1) {
            go(beat + 1)
            step()
          } else if (done) done()
        }, ms)
      }
      step()
    },
    forget() { key = ''; scene = undefined; clearTimeout(timer) },
  }
}

/** What journey-scene-app.js builds its actor from, and where it adds it. */
const parts = { frame, cursorEl, showLast, obj, ACTORS }
export { create, parts }
