// A step's animation: a small scene played beat by beat in place of the map. Plain DOM; styles are set through the
// CSSOM (the webview's CSP allows no inline style attributes); the look is journey-scene.css. The scene's format (actor
// types and their fields, beats) is the journey schema's: src/core/format/schema/journey.schema.json, typed as JScene in
// src/core/format/journeyModel.ts. The data side (layout, state at a beat, older names) is journey-scene-model.js.
// Used by media/map/animation.js (the panel) and test/journey-scene/player.html (a page that plays a scene, for videos).
// The web-app actor (journey-scene-app.js) adds itself with registerActor when a page imports it.
import { el, svgEl, runKey, between, baseName } from './common.js'
import { showCode } from './code-paint.js'
import { count, focusOf, layoutScene, obj, stateAt, statusTone, upgradeScene } from './journey-scene-model.js'

/** @typedef {import('./journey-scene-model.js').Scene} Scene */
/** @typedef {import('./journey-scene-model.js').Actor} Actor */
/** @typedef {import('./journey-scene-model.js').Beat} Beat */
/** @typedef {import('./journey-scene-model.js').Rect} Rect */
/**
 * What an actor type draws: its element, and `apply(st, fwd, beat)` to show its state at a beat (`fwd`: the beat was
 * stepped to forward, so its one-off moves play).
 * @typedef {{ el: HTMLElement, apply(st: Record<string, any>, fwd: boolean, beat: Beat): void }} ActorView
 */
/** @typedef {{ make(a: Actor): ActorView, size(a: Actor): [number, number] }} ActorType */

// ---------- tuning: sizes, the camera, timings ----------

/** How many rows a growing list keeps in view (its newest; the box is sized for them). */
const TERMINAL_ROWS = 6, FILE_ROWS = 8, CHAT_ROWS = 4
/** The box of every window-like actor (a browser, the web app), in scene px. */
export const WINDOW_BOX = /** @type {[number, number]} */ ([320, 250])
/** Where a window inside an actor box starts: under the box's label (`.scn-window` top). */
const WINDOW_TOP = 34
// The boxes' heights (scene px): a top part (the label, a header) and rows. A row's height is set here and handed to
// journey-scene.css as a custom property (boxVars), so the box and its rows cannot disagree.
/** A service: its top, its function's line (`.scn-fn`), a check (`.scn-check`); between SERVICE_MIN and SERVICE_MAX. */
const SERVICE_TOP = 62, SERVICE_FN_PX = 32, SERVICE_CHECK_PX = 25, SERVICE_MIN = 150, SERVICE_MAX = 240
/** A table: its top and a row (`.scn-row`, TABLE_ROW_H and 2 px to spare); at least TABLE_MIN. */
const TABLE_TOP = 58, TABLE_ROW_H = 38, TABLE_ROW_PX = TABLE_ROW_H + 2, TABLE_MIN = 150
/** A cluster: alone 140; with a cluster inside it (`.scn-inner`), that part, under its own pods or alone. */
const CLUSTER_H = 140, CLUSTER_PODS_TOP = 126, CLUSTER_INNER_ALONE_TOP = 50, CLUSTER_INNER_H = 122
/** A terminal (`.tm-win` line-height), a file (`.fl-win`): top and row. */
const TERMINAL_TOP = 66, TERMINAL_ROW_PX = 22, FILE_TOP = 60, FILE_ROW_PX = 20
/** A chat: top, a message (`.ch-msg`) and the gap between two. */
const CHAT_TOP = 58, CHAT_MSG_PX = 30, CHAT_GAP_PX = 6, CHAT_ROW_PX = CHAT_MSG_PX + CHAT_GAP_PX
/** A queue's or a gauge's box. */
const METER_BOX = /** @type {[number, number]} */ ([350, 132])
/** The camera's margin around the actor it looks at (scene px, both sides together), and its closest zoom. */
const CAMERA_PAD_W = 56, CAMERA_PAD_H = 36, CAMERA_MAX_SCALE = 2.4
/** The view: tall enough for one actor close up (VIEW_MIN_H, or VIEW_W_SHARE of its width), never most of the
 *  window (VIEW_WINDOW_SHARE of it, at most VIEW_MAX_H). */
const VIEW_MIN_H = 220, VIEW_MAX_H = 560, VIEW_W_SHARE = 0.74, VIEW_WINDOW_SHARE = 0.52
/** play(): a beat is held READ_MS, and READ_MS_PER_CHAR for each character of its caption (videos). */
const READ_MS = 1600, READ_MS_PER_CHAR = 55
/** At most this many beats show as dots. */
const DOTS_MAX = 12
/** The mouse pointer an actor draws where a beat clicks. */
const CURSOR_PATH = 'M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.7 L9.6 13 L15.5 13 Z'

/** The sizes journey-scene.css takes from here, as custom properties on the player. */
function boxVars(root) {
  const px = { 'window-top': WINDOW_TOP, 'table-row': TABLE_ROW_H, 'terminal-row': TERMINAL_ROW_PX, 'file-row': FILE_ROW_PX, 'chat-msg': CHAT_MSG_PX, 'chat-gap': CHAT_GAP_PX }
  for (const [k, v] of Object.entries(px)) root.style.setProperty(`--scn-${k}`, `${v}px`)
}

// ---------- parts every actor builds from ----------

function frame(a) {
  const e = el('div', `scn-actor scn-${a.type}`)
  const l = el('div', 'scn-label')
  l.append(el('b', '', a.label || a.id))
  if (a.sub) l.append(el('span', '', ` · ${a.sub}`))
  e.append(l)
  return e
}

/** A window inside an actor's box (`kind`: its own class, e.g. `tm-win`), under the box's label. */
function windowEl(kind) {
  return el('div', `scn-window ${kind}`)
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

/** A label and its value on one row (class `cls`). */
function kvRow(cls, k, v) {
  const r = el('div', cls)
  r.append(el('b', '', String(k ?? '')), el('span', '', String(v ?? '')))
  return r
}

/** A conversation's messages in `win` (class `cls`, then `me` or `them`, and `tool` for a tool call): mine are
 *  `from: 'me'` (or 'you'). Returns their elements. */
function chatList(win, messages, cls) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const mine = m.from === 'me' || m.from === 'you'
    const d = el('div', `${cls} ${mine ? 'me' : 'them'}${m.tool ? ' tool' : ''}`, m.text)
    win.append(d)
    return d
  })
}

// ---------- the actors ----------

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

/** A row's status pill (`.scn-pill`), in the editor's colours: amber while waiting or failed, the accent while live. */
const PILL_CLASS = { waiting: ' warn', bad: ' warn', live: ' live' }
const pillClass = (word) => {
  const tone = statusTone(word)
  return Object.hasOwn(PILL_CLASS, tone) ? PILL_CLASS[tone] : ''
}

/** A table row: its id and its pills, redrawn only when they change. */
function tableRow(r) {
  const el0 = el('div', `scn-row${r.old ? ' old' : ''}`)
  el0.append(el('code', '', r.id))
  let shown
  return {
    el: el0,
    /** What the row says now. */
    setChips(cs) {
      const k = cs.join('|')
      if (shown === k) return
      shown = k
      while (el0.children.length > 1) el0.lastChild?.remove()
      for (const c of cs) el0.append(el('span', `scn-pill${pillClass(c)}`, c))
    },
  }
}

/** A table / collection: rows; `show` of them are there, row `hi` is the one just written; `chips: { rowIndex: [...] }`:
 *  what a row says now (its status changed). */
function tableActor(a) {
  const e = frame(a)
  const body = el('div', 'scn-rows')
  const written = a.rows || []
  const rows = written.map((r) => {
    const row = tableRow(r)
    row.setChips(r.chips || [])
    body.append(row.el)
    return row
  })
  e.append(body)
  const base = written.filter((r) => r.old).length
  return {
    el: e,
    apply(st) {
      rows.forEach((r, i) => {
        r.el.classList.toggle('on', i < base + (st.show || 0))
        r.el.classList.toggle('hi', st.hi === i)
        r.setChips((st.chips && st.chips[i]) || written[i].chips || [])
      })
    },
  }
}

/** A pod: `made` (a ghost pod that exists now) and `gone` (it was there and is not any more: stopped, evicted,
 *  replaced), each with its own note. */
function podRow(p) {
  const d = el('div', `scn-pod${p.ghost ? ' ghost' : ''}`)
  const note = el('em', '', p.note || '')
  d.append(el('span', '', p.label), note)
  return {
    el: d,
    setMade(on) {
      d.classList.toggle('made', on)
      note.textContent = on ? (p.madeNote || '') : (p.note || '')
    },
    setGone(on) {
      d.classList.toggle('gone', on)
      if (on) note.textContent = p.goneNote || 'gone'
    },
  }
}

/** A cluster namespace: pods; a `ghost` pod is not there yet; `mark` points at one; `made: [i]`, `gone: [i]`. */
function clusterActor(a) {
  const e = frame(a)
  const body = el('div', 'scn-pods')
  const podsIn = (into, list) => (list || []).map((p) => {
    const pod = podRow(p)
    into.append(pod.el)
    return pod
  })
  const pods = podsIn(body, a.pods)
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
    innerPods = podsIn(ib, a.inner.pods)
    inner.append(il, ib)
    e.append(inner)
  }
  const podsAt = (list, mark, made, gone) => list.forEach((p, i) => {
    p.el.classList.toggle('mark', mark === i)
    p.setMade((made || []).includes(i))
    p.setGone((gone || []).includes(i))
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

/** What a browser actor shows when its journey does not say: a plain page, nothing of any one product. */
const PAGE_DEFAULTS = { url: 'http://localhost', title: 'Page', cart: 'Items', markLabel: 'Here', button: 'Add', products: ['Item 1', 'Item 2'] }

/** A web page in a browser: a small shop (`title`), two `products`, each with a `button`, and a cart (`cart`).
 *  `click`: the first product's button is pressed; `flash`: a screenshot is taken; `mark`: a highlight on the cart
 *  with its `markLabel`; `lock`: 'ok' (a padlock: the certificate is trusted) or 'warn' ("Not secure"). */
function browserActor(a) {
  const e = frame({ ...a, label: a.label || 'Browser' })
  const win = windowEl('br-win')
  const lock = el('span', 'br-lock')
  const bar = el('div', 'br-bar')
  const urlw = el('span', 'br-url')
  urlw.append(lock, el('span', 'br-addr', a.url || PAGE_DEFAULTS.url))
  bar.append(urlw)
  const top = el('div', 'br-top')
  const cartw = el('span', 'br-cartw')
  const mark = el('span', 'br-mark')
  mark.append(el('span', '', a.markLabel || PAGE_DEFAULTS.markLabel))
  cartw.append(el('span', 'br-cart', a.cart || PAGE_DEFAULTS.cart), mark)
  top.append(el('b', '', a.title || a.shop || PAGE_DEFAULTS.title), cartw)
  const grid = el('div', 'br-grid')
  const cursor = cursorEl('br-cursor')
  /** @type {HTMLElement | undefined} */
  let btn
  for (const p of (a.products || PAGE_DEFAULTS.products).slice(0, 2)) {
    const name = Array.isArray(p) ? p[0] : p
    const c = el('div', 'br-card')
    const b = el('span', 'br-btn', a.button || PAGE_DEFAULTS.button)
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
      btn?.classList.toggle('pressed', !!st.click)
      cursor.classList.toggle('at', !!st.click)
      if (fwd && beat.click === a.id) { void cursor.getBoundingClientRect(); e.classList.add('clicking') }
      mark.classList.toggle('on', !!st.mark)
      const lk = st.lock || a.lock || ''
      lock.className = `br-lock ${lk}`
      lock.textContent = lk === 'warn' ? 'Not secure' : ''
      if (lk === 'ok') lock.append(padlockEl())
      flash.classList.remove('go')
      if (fwd && /** @type {any} */ (beat).flash === a.id) { void flash.getBoundingClientRect(); flash.classList.add('go') }
    },
  }
}

/** A terminal: `lines`, each a command ("$ npm test") or a line it printed; `show` of them are there (the
 *  last TERMINAL_ROWS in view), line `hi` is the one just printed. Dark in every theme, like the app window. Keep a
 *  line to about 36 characters: a longer one is cut. */
function terminalActor(a) {
  const e = frame({ ...a, label: a.label || 'Terminal' })
  const win = windowEl('tm-win')
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

/** A file's line: its number (when `n` is given) and its text; `say(v)`: what it reads now (undefined: as written). */
function fileLine(t, n) {
  const d = el('div', 'fl-line')
  if (n !== undefined) d.append(el('i', '', String(n)))
  const tx = el('span', '', String(t))
  d.append(tx)
  return {
    el: d,
    say(v) {
      const now = v === undefined ? String(t) : String(v)
      if (tx.textContent !== now) tx.textContent = now
      d.classList.toggle('changed', v !== undefined)
    },
  }
}

/** A file (or a folder: its entries as lines): `lines` as they are in it, at most FILE_ROWS in view; `from`: the
 *  number of its first line (numbers are shown then). All of it is there unless a beat sets `show`; `hi`: the line
 *  (or [first, last]) the beat is about; `text: { i: "…" }`: lines that read differently now (marked as changed).
 *  Keep a line to about 34 characters: a longer one is cut. */
function fileActor(a) {
  const e = frame({ ...a, label: a.label || 'file' })
  const win = windowEl('fl-win')
  const lines = (a.lines || []).map((t, i) => {
    const line = fileLine(t, a.from ? a.from + i : undefined)
    win.append(line.el)
    return line
  })
  const els = lines.map((l) => l.el)
  e.append(win)
  return {
    el: e,
    apply(st) {
      const [h0, h1] = Array.isArray(st.hi) ? st.hi : [st.hi, st.hi]
      showLast(els, st.show === undefined ? lines.length : st.show, FILE_ROWS, (i) => h0 !== undefined && i >= h0 && i <= h1)
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
  const msgs = chatList(win, a.messages, 'ch-msg')
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
  const says = (u, w) => {
    const more = !w ? '' : u + w > max ? `, ${w} more does not fit` : `, ${w} more fits`
    return `${u} of ${max} ${a.unit || ''} in use${more}`
  }
  return {
    el: e,
    apply(st) {
      const u = st.used === undefined ? (a.used || 0) : st.used, w = st.want || 0
      used.style.width = `${Math.min(100, 100 * u / max)}%`
      want.style.width = `${Math.max(0, Math.min(100 - 100 * u / max, 100 * w / max))}%`
      want.classList.toggle('over', u + w > max)
      want.classList.toggle('on', w > 0)
      note.textContent = st.note || says(u, w)
    },
  }
}

// ---------- the actor types ----------

/** How many rows of `list` a box has room for: at least `min`, at most the `max` it keeps in view. */
const rowsShown = (list, min, max) => between(count(list), min, max)
function serviceH(a) {
  const h = SERVICE_TOP + (a.fn ? SERVICE_FN_PX : 0) + SERVICE_CHECK_PX * count(a.checks)
  return between(h, SERVICE_MIN, SERVICE_MAX)
}
function clusterH(a) {
  if (!a.inner) return CLUSTER_H
  return (count(a.pods) ? CLUSTER_PODS_TOP : CLUSTER_INNER_ALONE_TOP) + CLUSTER_INNER_H
}

/**
 * Every actor type: its builder and its box ([w, h] in scene px, for its content). Sized so that at a 400 px wide
 * scene the camera's scale is about 1 (camera(): min(vw / (w + CAMERA_PAD_W), vh / (h + CAMERA_PAD_H)), view ≈ 398 ×
 * 294), and every text rule is at least 11.5 px: nothing on screen below 11 px. A table grows with its rows (rows
 * never past the box); a service is as tall as its checks (no empty box); a list keeps its newest rows in view.
 * Filled by registerActor only.
 * @type {Map<string, ActorType>}
 */
const ACTORS = new Map()

/**
 * Adds actor type `type` (its builder and its box). The built-in ones are below; the web app (`app`) adds itself from
 * journey-scene-app.js. A type is registered once.
 * @param {string} type
 * @param {ActorType} t
 */
export function registerActor(type, { make, size }) {
  if (ACTORS.has(type)) throw new Error(`the scene's actor type "${type}" is registered twice`)
  ACTORS.set(type, { make, size })
}

registerActor('browser', { make: browserActor, size: () => WINDOW_BOX })
registerActor('service', { make: serviceActor, size: (a) => [290, serviceH(a)] })
registerActor('table', { make: tableActor, size: (a) => [350, Math.max(TABLE_MIN, TABLE_TOP + TABLE_ROW_PX * count(a.rows))] })
registerActor('cluster', { make: clusterActor, size: (a) => [350, clusterH(a)] })
registerActor('terminal', { make: terminalActor, size: (a) => [320, TERMINAL_TOP + TERMINAL_ROW_PX * rowsShown(a.lines, 3, TERMINAL_ROWS)] })
registerActor('file', { make: fileActor, size: (a) => [320, FILE_TOP + FILE_ROW_PX * rowsShown(a.lines, 3, FILE_ROWS)] })
registerActor('chat', { make: chatActor, size: (a) => [320, CHAT_TOP + CHAT_ROW_PX * rowsShown(a.messages, 2, CHAT_ROWS)] })
registerActor('queue', { make: queueActor, size: () => METER_BOX })
registerActor('gauge', { make: gaugeActor, size: () => METER_BOX })

/** Actor `a`'s type (undefined: none of them; the actor is left out). */
const actorType = (a) => (typeof a.type === 'string' ? ACTORS.get(a.type) : undefined)
/** Actor `a`'s box, undefined for an unknown type. */
const sizeOf = (a) => actorType(a)?.size(a)

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
  boxVars(root)
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

/** opts: { onBeat(i, how), onClose(), onNextStep?(), height? }. `how`: 'go' when the beat was moved to (‹ ›, the keys,
 *  go()), else it came with the scene shown. `onNextStep`: at the last beat › becomes "Next step ›". */
function create(opts) {
  opts = opts || {}
  const { root, prev, next, pos, dots, file, close, view, world, cap, codeEl } = playerEl()

  /** What the player shows. */
  const p = {
    /** @type {Scene | undefined} the scene shown (a step's `scene`, in today's names) */
    scene: undefined,
    /** its key: the same key again keeps the beat */
    key: '',
    /** the beat on screen (0-based) */
    beat: 0,
    /** @type {Record<string, ActorView>} the scene's actors by id */
    actors: Object.create(null),
    /** @type {Record<string, Rect>} their boxes (layoutScene) */
    rects: Object.create(null),
    /** @type {{ f: string, t: string, y: number, x1: number, x2: number, ln: SVGElement }[]} the wires and their lines */
    wires: [],
    /** @type {HTMLElement} the pill that travels a wire */
    packet: el('div', 'scn-packet'),
    /** play()'s next beat */
    timer: 0,
    /** the step's own file (a beat's code in another one names its file) */
    stepFile: '',
    /** a next step follows */
    hasNext: false,
    /** @type {{ w: number, h: number } | undefined} the view's size when last laid out */
    size: undefined,
  }
  /** The scene shown; only called once there is one. */
  const shown = () => /** @type {Scene} */ (p.scene)

  function build() {
    const scene = shown()
    world.textContent = ''
    p.actors = Object.create(null)
    const L = layoutScene(scene, sizeOf)
    p.rects = L.rects
    const lines = svgEl('svg', { class: 'scn-wires', width: L.W, height: L.H })
    world.append(lines)
    p.wires = L.wires.map((w) => {
      const ln = svgEl('line', { x1: w.x1, y1: w.y, x2: w.x2, y2: w.y })
      lines.append(ln)
      return { ...w, ln }
    })
    for (const a of scene.actors || []) {
      const r = p.rects[a.id]
      const type = actorType(a)
      if (!r || !type) continue
      const act = type.make(a)
      Object.assign(act.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
      world.append(act.el)
      p.actors[a.id] = act
    }
    const packet = el('div', 'scn-packet')
    // Once it has flown it stays gone: a re-render re-inserts the scene, which would replay the animation.
    packet.addEventListener('animationend', () => { packet.className = 'scn-packet' })
    world.append(packet)
    p.packet = packet
    world.style.width = `${L.W}px`
    world.style.height = `${L.H}px`
  }

  function camera() {
    const vw = view.clientWidth, vh = view.clientHeight
    if (!vw || !vh || !p.scene) return
    const r = p.rects[focusOf(p.scene, p.rects, p.beat)]
    if (!r) return
    const s = Math.min(vw / (r.w + CAMERA_PAD_W), vh / (r.h + CAMERA_PAD_H), CAMERA_MAX_SCALE)
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2
    const tx = vw / 2 - cx * s, ty = vh / 2 - cy * s
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
    // A wire with an end out of view would be a stub from the box to the view's edge, joined to nothing: hidden.
    const left = -tx / s - 1, right = (vw - tx) / s + 1, top = -ty / s, bottom = (vh - ty) / s
    for (const x of p.wires) x.ln.classList.toggle('out', x.x1 < left || x.x2 > right || x.y < top || x.y > bottom)
  }

  function layout() {
    const vw = view.clientWidth
    if (!vw) return
    view.style.height = `${opts.height ? opts.height : viewHeight(vw)}px`
    // A pill in flight when the size changes would end wherever the old camera put it.
    const sz = { w: vw, h: view.clientHeight }
    if (p.size && (sz.w !== p.size.w || sz.h !== p.size.h)) p.packet.className = 'scn-packet'
    p.size = sz
    camera()
  }
  /** The view's height at width `vw` (px). */
  function viewHeight(vw) {
    const h = Math.min(vw * VIEW_W_SHARE, window.innerHeight * VIEW_WINDOW_SHARE, VIEW_MAX_H)
    return Math.round(Math.max(VIEW_MIN_H, h))
  }

  /** Each actor at the beat: its state, dimmed unless looked at (or sending the beat's packet); the packet's flight. */
  function applyActors(b, fwd) {
    const scene = shown()
    const st = stateAt(scene, p.beat)
    const focus = focusOf(scene, p.rects, p.beat)
    for (const id of Object.keys(p.actors)) {
      p.actors[id].apply(st[id] || {}, fwd, b)
      p.actors[id].el.classList.toggle('dim', id !== focus && !(b.packet && fwd && id === b.packet.from))
    }
    p.packet.className = 'scn-packet'
    for (const x of p.wires) x.ln.classList.remove('lit')
    if (b.packet && fwd) sendPacket(p.packet, p.wires, p.rects, b.packet)
  }

  function applyCaption(b) {
    cap.textContent = ''
    cap.append(el('span', '', b.caption || ''))
    if (b.muted) cap.append(el('span', 'scn-muted', ` ${b.muted}`))
  }

  /** "n / N" for screen readers, and the beats as dots when there are few. */
  function applyCounter() {
    const n = shown().beats.length
    pos.textContent = `${p.beat + 1} / ${n}`
    pos.setAttribute('aria-label', `Beat ${p.beat + 1} of ${n}`)
    const asDots = n <= DOTS_MAX
    pos.classList.toggle('sr', asDots)
    dots.hidden = !asDots
    if (!asDots) return
    dots.textContent = ''
    for (let k = 0; k < n; k++) dots.append(el('i', k === p.beat ? 'on' : k < p.beat ? 'past' : ''))
    dots.title = `Beat ${p.beat + 1} of ${n}`
  }

  /** The beat's code (a beat without code shows none; one with code keeps the last lines until its own arrive: no
   *  flicker) and its file, named when it is not the step's. */
  function applyFile(b) {
    if (!b.code) showCode(codeEl, undefined)
    const f = b.code && b.code.file
    const other = !!f && !!p.stepFile && f !== p.stepFile
    file.textContent = other ? baseName(f) : ''
    file.title = other ? f : ''
    file.hidden = !other
  }

  /** The beat on screen, drawn; `fwd`: stepped to forward (its one-off moves play). */
  function apply(fwd) {
    const b = shown().beats[p.beat]
    applyActors(b, fwd)
    applyCaption(b)
    applyCounter()
    applyFile(b)
    updateNav()
    camera()
  }

  /** ‹ and › for the beat on screen. */
  function updateNav() {
    const last = p.beat === shown().beats.length - 1
    // Never disable or hide the button that has the focus: the focus would drop to the page.
    const focused = document.activeElement
    const losing = (p.beat === 0 && focused === prev) || (last && focused === next && !p.hasNext)
    if (root.contains(focused) && focused !== root && losing) root.focus({ preventScroll: true })
    prev.disabled = p.beat === 0
    // At the last beat › walks on to the next step, the animation still on; on the last step it is not there.
    const toStep = last && p.hasNext
    next.textContent = toStep ? 'Next step ›' : '›'
    next.className = toStep ? 'link scn-next step' : 'icon scn-next'
    next.title = toStep ? 'Next step' : 'Next (→)'
    next.hidden = last && !p.hasNext
    next.disabled = false
  }

  /** To beat i; `quiet`: drawn again even when it is the beat shown; `still`: without the beat's flight (a jump). */
  function go(i, quiet, still) {
    if (!p.scene) return
    const n = Math.max(0, Math.min(p.scene.beats.length - 1, i))
    const fwd = !still && n === p.beat + 1
    if (n === p.beat && !quiet) return
    p.beat = n
    apply(fwd)
    if (opts.onBeat) opts.onBeat(p.beat, 'go')
  }

  prev.onclick = () => go(p.beat - 1)
  next.onclick = () => {
    if (p.scene && p.beat === p.scene.beats.length - 1) { if (p.hasNext && opts.onNextStep) opts.onNextStep() }
    else go(p.beat + 1)
  }
  close.onclick = () => opts.onClose && opts.onClose()
  root.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    runKey(e, {
      ArrowRight: () => go(p.beat + 1),
      ArrowLeft: () => go(p.beat - 1),
      Home: !!p.scene && (() => go(0)),
      End: !!p.scene && (() => go(shown().beats.length - 1)),
      Escape: () => { if (opts.onClose) opts.onClose() },
    }, true)
  })

  return {
    el: root,
    get beat() { return p.beat },
    /** The current beat's line and the lines around it: { file, line, from, lines } (numbers 1-based), or nothing. */
    code(c) { showCode(codeEl, c) },
    get count() { return p.scene ? p.scene.beats.length : 0 },
    /** Shows a scene; the same key again keeps the beat (a re-render), another starts at `o.beat` (or its first).
     *  o: { file: the step's file (a beat in another file names it), next: there is a next step, beat, still: shown
     *  without its flight }.
     *  @param {Scene} s @param {string} k @param {{ file?: string, next?: boolean, beat?: number, still?: boolean }} [o] */
    show(s, k, o) {
      o = o || {}
      const same = k === p.key && !!p.scene
      p.stepFile = o.file || ''
      const had = p.hasNext
      p.hasNext = !!o.next
      if (same) { if (had !== p.hasNext) apply(false); return }
      clearTimeout(p.timer)
      p.scene = upgradeScene(s); p.key = k
      showCode(codeEl, undefined)
      p.beat = Math.max(0, Math.min(s.beats.length - 1, o.beat || 0))
      build()
      apply(!o.still)
      if (opts.onBeat) opts.onBeat(p.beat)
    },
    go,
    layout,
    /** The keys work at once. */
    focus() { root.focus({ preventScroll: true }) },
    /** From the first beat again, as if just opened. */
    restart() { if (p.scene) { p.beat = 0; apply(true); if (opts.onBeat) opts.onBeat(0) } },
    /** Plays every beat once, each held long enough to read (videos). */
    play(done, hold) {
      const readMs = (b) => READ_MS + READ_MS_PER_CHAR * ((b.caption || '').length + (b.muted || '').length)
      const step = () => {
        const b = shown().beats[p.beat]
        // `hold`: a beat's own time in a video (not part of the journey format).
        const ms = /** @type {any} */ (b).hold || (hold ? hold(b) : readMs(b))
        p.timer = window.setTimeout(() => {
          if (p.beat < shown().beats.length - 1) {
            go(p.beat + 1)
            step()
          } else if (done) done()
        }, ms)
      }
      step()
    },
    forget() { p.key = ''; p.scene = undefined; clearTimeout(p.timer) },
  }
}

/** What journey-scene-app.js builds its actor from. */
const parts = { frame, windowEl, cursorEl, showLast, kvRow, chatList, obj }
export { create, parts }
