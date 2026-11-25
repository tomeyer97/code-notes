// A step's animation as data, without the DOM: older scenes in today's names, where every actor goes, each actor's
// state at a beat, the actor a beat looks at, what a status word means. journey-scene.js draws it; unit tests
// (test/journeySceneModel.test.ts) load it as it is. The scene's format: src/core/format/schema/journey.schema.json.

/** @typedef {import('../src/core/format/journeyModel').JScene} Scene */
/** @typedef {import('../src/core/format/journeyModel').JActor} Actor */
/** @typedef {import('../src/core/format/journeyModel').JBeat} Beat */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ f: string, t: string, y: number, x1: number, x2: number }} WireLine */

/** `v` when it is a plain object, else an empty one. */
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
/** How many items `list` has (0 for none). */
export const count = (list) => (Array.isArray(list) ? list.length : 0)

/** The gaps between columns and between the boxes of a column (scene px). */
const COL_GAP = 100, ROW_GAP = 20

// ---------- older scenes in today's names ----------

/** Older journeys' name of the web-app actor type. */
const TYPE_ALIAS = { console: 'app' }
/** Older journeys' names of the app's screens. */
const SCREEN_ALIAS = { 'run-dialog': 'dialog', 'run-page': 'detail', login: 'signin' }
const alias = (table, name) => (typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : name)

/** An app actor with its older flat fields moved into its screens (`dialog`, `detail`, `signin`). */
function upgradeAppActor(a) {
  const dialog = obj(a.dialog), detail = obj(a.detail), signin = obj(a.signin)
  const lines = Array.isArray(dialog.lines) ? dialog.lines : a.env ? [['Environment', a.env]] : []
  return {
    ...a,
    type: 'app',
    screen: a.screen && alias(SCREEN_ALIAS, a.screen),
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

/** A beat's state of an app actor with its older fields in today's names. */
function upgradeAppState(st) {
  const s = obj(st)
  return {
    ...s,
    screen: s.screen && alias(SCREEN_ALIAS, s.screen),
    cards: s.cards !== undefined ? s.cards : s.findings || 0,
    newCard: s.newCard !== undefined ? s.newCard : s.newFinding,
    pane: s.pane === 'desktop' ? 'picture' : s.pane,
    picture: s.picture || s.desktop,
  }
}

/**
 * The scene in today's names, read once when it is shown: an actor type's older name (`console`), and the app's
 * older fields and screen names, in its actors and in every beat's `set`. Built with own properties only, so ids
 * such as "__proto__" stay ids.
 * @param {Scene} scene
 * @returns {Scene}
 */
export function upgradeScene(scene) {
  const actors = (Array.isArray(scene.actors) ? scene.actors : []).map((a) => {
    const type = alias(TYPE_ALIAS, obj(a).type)
    return type === 'app' ? upgradeAppActor(a) : a
  })
  const apps = new Set(actors.filter((a) => a.type === 'app').map((a) => a.id))
  const beats = scene.beats.map((b) => {
    if (!b || !b.set || typeof b.set !== 'object') return b
    const set = Object.fromEntries(Object.entries(b.set).map(([id, st]) => [id, apps.has(id) ? upgradeAppState(st) : st]))
    return { ...b, set }
  })
  return { ...scene, actors, beats }
}

// ---------- where everything goes ----------

/**
 * Where everything goes, in scene px: the actors in columns (`col`), each column top to bottom; a wire level with the
 * middle of its smaller end. `sizeOf(a)`: an actor's box [w, h], undefined for a type there is none of (left out).
 * @param {Scene} scene
 * @param {(a: Actor) => [number, number] | undefined} sizeOf
 * @returns {{ rects: Record<string, Rect>, W: number, H: number, wires: WireLine[] }}
 */
export function layoutScene(scene, sizeOf) {
  /** @type {{ a: Actor, size: [number, number] }[][]} */
  const cols = []
  for (const a of scene.actors || []) {
    const size = sizeOf(a)
    if (!size) continue
    const c = a.col || 0
    ;(cols[c] = cols[c] || []).push({ a, size })
  }
  /** @type {Record<string, Rect>} */
  const rects = Object.create(null)
  let x = 0, H = 0
  for (const col of cols) {
    if (!col) continue
    let y = 0, w = 0
    for (const { a, size: [aw, ah] } of col) {
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

// ---------- the beats ----------

/**
 * Every actor's state at beat `i`: every `set` up to it, merged.
 * @param {Scene} scene
 * @param {number} i
 * @returns {Record<string, Record<string, any>>}
 */
export function stateAt(scene, i) {
  const st = Object.create(null)
  for (let k = 0; k <= i; k++) {
    const s = scene.beats[k].set || {}
    for (const id of Object.keys(s)) st[id] = { ...(st[id] || {}), ...s[id] }
  }
  return st
}

/**
 * The actor beat `i` looks at: its own focus, else (older "all" beats) the last one looked at before, else the next.
 * @param {Scene} scene
 * @param {Record<string, Rect>} rects
 * @param {number} i
 */
export function focusOf(scene, rects, i) {
  const at = (k) => scene.beats[k].focus
  for (let k = i; k >= 0; k--) if (rects[at(k)]) return at(k)
  for (let k = i + 1; k < scene.beats.length; k++) if (rects[at(k)]) return at(k)
  return Object.keys(rects)[0]
}

// ---------- status words ----------

/** What a status word means, for every actor that shows one (a table row's pill, the app's chip). */
const STATUS_TONE = { queued: 'waiting', starting: 'live', running: 'live', passed: 'good', failed: 'bad' }

/**
 * The tone of status word `word`: 'waiting', 'live', 'good', 'bad', or 'neutral' for any other word.
 * @param {unknown} word
 */
export function statusTone(word) {
  const w = String(word).toLowerCase()
  return Object.hasOwn(STATUS_TONE, w) ? STATUS_TONE[w] : 'neutral'
}
