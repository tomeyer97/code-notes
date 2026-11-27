// A step's scene against what the scene engine draws (media/journey-scene.js): its actors, wires and beats. The field
// sizes come from the journey schema (limits.ts); the rules across fields (ids that exist, indexes into what an
// actor has, text sharing a line) are here, one checker per actor type.
import { collector, Issue } from './issues'
import * as L from './limits'
import { ActorType } from './limits'
import { isAre, isInt, isObj, len, or, pyRound, repr, sorted, str, truthy } from './py'

type Actor = Record<string, any>
type Say = (text: string) => void

/** An actor's type, its older name read as the current one. */
export const typeOf = (a: Actor): unknown => (typeof a.type === 'string' && a.type in L.TYPE_ALIAS ? L.TYPE_ALIAS[a.type] : a.type)
const isType = (t: unknown): t is ActorType => (L.TYPES as readonly unknown[]).includes(t)
/** A list field of an actor; anything else is none. */
const list = (a: Actor, key: string): unknown[] => (Array.isArray(a[key]) ? a[key] : [])
/** Python's len() of what a JSON field holds (0 for none). */
const size = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === 'string' ? len(v) : isObj(v) ? Object.keys(v).length : 0)
const get = (o: Record<string, any>, key: string, missing: unknown = '') => (key in o ? o[key] : missing)
const tooLong = (v: unknown, n: number) => len(str(v)) > n

export function sceneIssues(k: number, sc: unknown): Issue[] {
  const c = collector(`step ${k} scene: `)
  if (!isObj(sc)) {
    c.problem('must be an object {actors, wires, beats}')
    return c.issues
  }
  for (const key of Object.keys(sc)) if (!L.SCENE_KEYS.includes(key)) c.refuse(`"${key}" is not part of a scene (actors, wires, beats); the engine ignores it`)
  const { actors, beats } = sc
  if (!Array.isArray(actors) || !actors.length || !Array.isArray(beats) || !beats.length) {
    c.problem('needs a non-empty "actors" list and a non-empty "beats" list')
    return c.issues
  }
  const ids = actorIssues(actors, c)
  const pairs = wireIssues(get(sc, 'wires', []), ids, c)
  beatIssues(k, beats, ids, pairs, c)
  return c.issues
}

type Collector = ReturnType<typeof collector>

/** Each actor checked; returns the actors by id. */
function actorIssues(actors: unknown[], c: Collector): Map<string, Actor> {
  const ids = new Map<string, Actor>()
  actors.forEach((a, i) => {
    if (!isObj(a) || typeof a.id !== 'string' || !a.id) {
      c.problem(`actors[${i}] needs a string "id"`)
      return
    }
    const aid = a.id
    const t = typeOf(a)
    if (ids.has(aid)) c.problem(`two actors have the id "${aid}"`)
    if (aid === 'all') c.problem('"all" is not an actor id')
    ids.set(aid, a)
    if (!isType(t)) {
      c.problem(`actor ${aid}: type ${repr(t)} does not exist (types: ${L.TYPES.join(', ')}): the engine skips it`)
      return
    }
    const extra = Object.keys(a).filter((x) => !L.COMMON_KEYS.includes(x) && !L.ACTOR_KEYS[t].includes(x))
    if (extra.length) {
      c.refuse(`actor ${aid}: ${sorted(extra).join(', ')} ${isAre(extra.length)} not read by a ${t} (it reads ${sorted(L.ACTOR_KEYS[t]).join(', ')}): the engine ignores it`)
    }
    if ('col' in a && !(isInt(a.col) && a.col >= 0 && a.col <= 3)) c.problem(`actor ${aid}: "col" is a column number 0-3`)
    const sub = or(a.sub, '')
    const lab = str(or(a.label, L.DEFAULT_LABEL[t] ?? aid)) + (truthy(sub) ? ` · ${str(sub)}` : '')
    if (len(lab) > L.LABEL_CHARS[t]) {
      c.problem(`actor ${aid}: label and sub "${lab}" are ${len(lab)} chars; a ${t} box holds about ${L.LABEL_CHARS[t]} on its top line: shorten them`)
    }
    const prefix = `actor ${aid}: `
    ACTORS[t](a, (m) => c.problem(prefix + m), (m) => c.warning(prefix + m))
  })
  if (actors.length > L.MAX_ACTORS) c.refuse(`${actors.length} actors (max ${L.MAX_ACTORS}: the parts this step touches; one box per part)`)
  return ids
}

/** What each actor type draws, checked: `problem` and `warning` say it (without the actor's name). */
const ACTORS: Record<ActorType, (a: Actor, problem: Say, warning: Say) => void> = {
  service(a, problem) {
    const fn = get(a, 'fn')
    if (tooLong(fn, L.FN_CHARS)) problem(`fn "${str(fn)}" is ${len(str(fn))} chars (max ${L.FN_CHARS}: the name and "()")`)
    const checks = list(a, 'checks')
    if (checks.length > L.MAX_CHECKS) problem(`${checks.length} checks (max ${L.MAX_CHECKS})`)
    for (const x of checks) if (tooLong(x, L.MAX_CHECK)) problem(`check "${str(x)}" is ${len(str(x))} chars (max ${L.MAX_CHECK})`)
  },
  table(a, problem) {
    const rows = list(a, 'rows')
    if (rows.length > L.MAX_ROWS) problem(`${rows.length} rows (max ${L.MAX_ROWS})`)
    for (const r of rows) {
      if (!isObj(r) || typeof r.id !== 'string') {
        problem('a row is {"id": "…", "chips": ["…"], "old"?: true}')
        continue
      }
      const px = rowPx(r.id, or(r.chips, []))
      if (px > L.ROW_PX) problem(`row "${r.id}" with chips ${str(r.chips)} is about ${px} px wide (the row holds ${L.ROW_PX}): a shorter id or fewer, shorter chips`)
    }
  },
  cluster(a, problem) {
    const pods = list(a, 'pods')
    for (const m of podsIssues(pods, L.PODS_PX, 32, 12)) problem(m)
    const inner = a.inner
    if (inner === undefined || inner === null) return
    if (!isObj(inner)) {
      problem('"inner" is {"label", "sub"?, "ghost"?, "pods"}')
      return
    }
    const il = str(or(inner.label, 'cluster')) + (truthy(inner.sub) ? ` · ${str(inner.sub)}` : '')
    if (len(il) > L.INNER_LABEL_CHARS) problem(`inner label and sub "${il}" are ${len(il)} chars (about ${L.INNER_LABEL_CHARS} fit)`)
    for (const m of podsIssues(Array.isArray(inner.pods) ? inner.pods : [], L.INNER_PODS_PX, 24, 10)) problem(`inner ${m}`)
    if (pods.length > 2) problem(`${pods.length} pods above an inner cluster (1 or 2 fit)`)
  },
  app(a, problem, warning) {
    for (const i of appIssues(a)) (i.level === 'warning' ? warning : problem)(i.text)
  },
  browser(a, problem) {
    for (const [key, n] of L.BROWSER_CHARS) if (tooLong(get(a, key), n)) problem(`${key} "${str(a[key])}" is ${len(str(a[key]))} chars (max ${n})`)
    const name = str(or(a.title, or(a.shop, 'Shop'))), cart = str(or(a.cart, 'Cart 0'))
    if (len(name) + len(cart) > L.SHOP_TOP) problem(`title "${name}" and cart "${cart}" share one line: ${len(name) + len(cart)} chars (max ${L.SHOP_TOP})`)
    for (const p of list(a, 'products').slice(0, 2)) {
      const nm = Array.isArray(p) && p.length ? p[0] : p
      if (tooLong(nm, L.PRODUCT_CHARS)) problem(`product "${str(nm)}" is ${len(str(nm))} chars (max ${L.PRODUCT_CHARS})`)
    }
  },
  file(a, problem) {
    const numbered = truthy(a.from)
    const lim = numbered ? L.FILE_NUM_CHARS : L.FILE_CHARS
    if ('from' in a && !(isInt(a.from) && a.from >= 1)) problem('"from" is the number of the first line (omit it for a folder or a made-up document)')
    for (const ln of list(a, 'lines')) {
      if (tooLong(ln, lim)) problem(`line "${str(ln)}" is ${len(str(ln))} chars (max ${lim}${numbered ? ' with line numbers' : ''}; a longer one is cut)`)
    }
  },
  chat(a, problem) {
    for (const m of list(a, 'messages')) {
      if (!(isObj(m) && ['me', 'them'].includes(m.from) && typeof m.text === 'string')) {
        problem('a message is {"from": "me" | "them", "text": "…", "tool"?: true}')
        continue
      }
      const tool = truthy(m.tool)
      const lim = tool ? L.CHAT_TOOL_CHARS : L.CHAT_CHARS
      if (len(m.text) > lim) problem(`message "${m.text}" is ${len(m.text)} chars (max ${lim}${tool ? ' for a tool call' : ''}; one line)`)
    }
  },
  queue(a, problem) {
    if ('slots' in a && !(isInt(a.slots) && a.slots >= 1)) problem(`"slots" is a number of places (${L.QUEUE_SLOTS} are drawn at most; "cap" says the real size)`)
    if (tooLong(get(a, 'cap'), L.NOTE_CHARS)) problem(`cap "${str(a.cap)}" is ${len(str(a.cap))} chars (max ${L.NOTE_CHARS})`)
  },
  gauge(a, problem) {
    if (!(isNumber(a.max) && Number(a.max) > 0)) problem('"max" is the limit, a number above 0')
  },
  terminal(a, problem) {
    for (const ln of list(a, 'lines')) {
      if (tooLong(ln, L.MAX_TERM_LINE)) problem(`line "${str(ln)}" is ${len(str(ln))} chars (max ${L.MAX_TERM_LINE}; a longer one is cut): shorten it, keeping what the code prints`)
    }
  },
}

/** A number as Python's isinstance(v, (int, float)) sees it (a boolean is one). */
const isNumber = (v: unknown) => typeof v === 'number' || typeof v === 'boolean'

/** The wires checked; returns the pairs of actors they join, both ways. */
function wireIssues(wires: unknown, ids: Map<string, Actor>, c: Collector): Set<string> {
  const pairs = new Set<string>()
  if (!Array.isArray(wires)) {
    c.problem('"wires" is a list of [fromId, toId] pairs')
    return pairs
  }
  for (const w of wires) {
    if (!(Array.isArray(w) && w.length === 2 && w.every((x) => typeof x === 'string' && ids.has(x)))) {
      c.problem(`wire ${str(w)}: a wire is [fromId, toId] between two actors of this scene`)
      continue
    }
    pairs.add(`${w[0]}\n${w[1]}`).add(`${w[1]}\n${w[0]}`)
  }
  return pairs
}

function beatIssues(k: number, beats: unknown[], ids: Map<string, Actor>, pairs: Set<string>, c: Collector) {
  const n = beats.length
  if (n > L.MAX_BEATS) c.problem(`${n} beats (max ${L.MAX_BEATS}; aim for ${L.MIN_BEATS}-${L.SOFT_BEATS}): one thing happening per beat`)
  else if (n > L.SOFT_BEATS) c.warning(`${n} beats (aim for ${L.MIN_BEATS}-${L.SOFT_BEATS}): merge two`)
  else if (n < L.MIN_BEATS) c.refuse(`${n} beats (want ${L.MIN_BEATS}-${L.SOFT_BEATS}); a step with less to show gets no scene (rmscene ${k})`)
  const types = new Set([...ids.values()].map(typeOf))
  const isActor = (v: unknown): v is string => typeof v === 'string' && ids.has(v)
  let bare = 0
  const shown = new Map<string, unknown>()
  beats.forEach((b, i0) => {
    const i = i0 + 1
    const bn = `beat ${i}`
    if (!isObj(b)) {
      c.problem(`${bn} is not an object`)
      return
    }
    const extra = Object.keys(b).filter((x) => !L.BEAT_KEYS.includes(x))
    if (extra.length) c.refuse(`${bn}: ${sorted(extra).join(', ')} ${isAre(extra.length)} not part of a beat (${sorted(L.BEAT_KEYS).join(', ')})`)
    const f = b.focus
    if (f === 'all') c.problem(`${bn}: focus "all" (a zoomed-out view too small to read): focus the one actor whose line the beat lights`)
    else if (!isActor(f)) c.problem(`${bn}: focus ${repr(f)} is not an actor of this scene (${[...ids.keys()].join(', ')})`)
    const cap = str(get(b, 'caption')).trim(), mut = str(get(b, 'muted')).trim()
    if (!cap) c.problem(`${bn}: no caption`)
    else if (len(cap) > L.SOFT_CAPTION) c.warning(`${bn}: the caption is ${len(cap)} chars (aim for < 60, max ~${L.SOFT_CAPTION}: read in three seconds); move a clause to "muted" or cut it: "${cap}"`)
    else if (len(cap) + len(mut) > L.SOFT_CAPTION_ALL) c.warning(`${bn}: caption and muted are ${len(cap) + len(mut)} chars together (aim for <= ${L.SOFT_CAPTION_ALL}: read in three seconds)`)
    setIssues(bn, get(b, 'set', {}), ids, shown, c)
    if (isActor(f) && L.STARTS_EMPTY.includes(ids.get(f)?.type) && !truthy(shown.get(f))) {
      c.warning(`${bn}: focus on ${ids.get(f)?.type} ${f} while none of its lines is shown yet (set {"${f}": {"show": 1}})`)
    }
    const p = b.packet
    if (p !== undefined && p !== null) {
      if (!(isObj(p) && isActor(p.from) && isActor(p.to))) c.problem(`${bn}: a packet is {from, to, label} between two actors of this scene`)
      else if (!pairs.has(`${p.from}\n${p.to}`)) c.problem(`${bn}: packet ${p.from} -> ${p.to} has no wire to travel on (add ["${p.from}", "${p.to}"] to wires): the engine does not show it`)
      else if (tooLong(get(p, 'label'), L.MAX_PACKET)) c.warning(`${bn}: packet label "${str(p.label)}" is ${len(str(p.label))} chars (aim for <= ${L.MAX_PACKET})`)
    }
    const browser = (v: unknown) => isActor(v) && ids.get(v)?.type === 'browser'
    const click = b.click
    if (truthy(click) && !types.has('browser') && !types.has('app')) c.refuse(`${bn}: "click" does nothing without a browser or app actor`)
    else if (truthy(click) && !types.has('app') && !browser(click)) c.refuse(`${bn}: click ${repr(click)} must be the id of the browser actor the click happens in`)
    if (truthy(b.flash) && !browser(b.flash)) c.refuse(`${bn}: flash ${repr(b.flash)} must be the id of a browser actor (the screenshot flash)`)
    const code = b.code
    if (code === undefined || code === null) {
      bare++
      if (bare === 2) c.warning(`beats ${i - 1} and ${i} have no code line: never two in a row (a beat without code is for something with no line in this repo; keep those rare)`)
    } else {
      bare = 0
      if (!(isObj(code) && typeof code.file === 'string' && isInt(code.line))) c.problem(`${bn}: code is {"file": "<repo path>", "line": <n>} (the script reads the text)`)
    }
  })
  if (!beats.some((b) => isObj(b) && truthy(b.code))) c.problem('no beat has a code line: a scene lights the code that does what it shows')
}

/** A beat's `set`: actors it names, what it changes on each. Records what terminals and chats show. */
function setIssues(bn: string, set: unknown, ids: Map<string, Actor>, shown: Map<string, unknown>, c: Collector) {
  if (!isObj(set)) {
    c.problem(`${bn}: "set" is {actorId: {…}}`)
    return
  }
  for (const [aid, ch] of Object.entries(set)) {
    const a = ids.get(aid)
    if (!a) {
      c.problem(`${bn}: set on ${repr(aid)}, which is not an actor of this scene`)
      continue
    }
    const t = typeOf(a)
    if (!isObj(ch)) {
      c.problem(`${bn}: set.${aid} is an object of what changes`)
      continue
    }
    const takes = isType(t) ? L.SET_KEYS[t] : []
    const bad = Object.keys(ch).filter((x) => !takes.includes(x))
    if (bad.length) c.refuse(`${bn}: set.${aid}: ${sorted(bad).join(', ')} does nothing on a ${str(t)} (it takes ${sorted(takes).join(', ')})`)
    if (isType(t)) for (const m of STATES[t](a, ch)) c.refuse(`${bn}: set.${aid}: ${m}`)
    if (L.STARTS_EMPTY.includes(t as string) && 'show' in ch) shown.set(aid, ch.show)
  }
}

/** A table row's width in px. */
function rowPx(id: unknown, chips: unknown): number {
  const pills = iter(chips).reduce((w: number, x) => w + L.PILL_GAP + L.PILL_PAD + L.PILL_PX * len(str(x)), 0)
  return pyRound(Math.max(L.ROW_ID_MIN_PX, L.MONO_13_PX * len(str(id))) + pills)
}

/** What Python's `for x in v` walks: a list's items, a string's characters, an object's keys. */
function iter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [...v]
  if (isObj(v)) return Object.keys(v)
  return []
}

/** Pods side by side: a problem when they do not fit `room` px. */
function podsIssues(pods: unknown[], room: number, pad: number, gap: number): string[] {
  const out: string[] = []
  let w = 0
  for (const p of pods) {
    if (!isObj(p) || typeof p.label !== 'string') {
      out.push('a pod is {"label", "note"?, "madeNote"?, "ghost"?}')
      continue
    }
    w += pad + Math.max(L.LABEL_14_PX * len(p.label), L.NOTE_12_PX * Math.max(len(str(get(p, 'note'))), len(str(get(p, 'madeNote')))))
  }
  w += gap * Math.max(0, pods.length - 1)
  if (w > room) {
    const names = pods.filter(isObj).map((p) => str(p.label)).join(', ')
    out.push(`pods ${names} are about ${pyRound(w)} px side by side (${room} fit): fewer pods, or shorter labels and notes`)
  }
  return out
}

// ---------- a beat's `set`, per actor type: indexes and values that point at nothing the actor has ----------

type Changes = Record<string, any>

/** A list index into `m` items, or -1 for none. */
const isIndex = (v: unknown, m: number) => isInt(v) && v >= -1 && v < m
/** A count from 0 to `m`. */
const isCount = (v: unknown, m: number) => isInt(v) && v >= 0 && v <= m
const count = (a: Actor, key: string) => (Array.isArray(a[key]) ? a[key].length : 0)

/** The rules every type shares: an index (`key` one of `m` `what`), a count (`key` up to `m`). */
function rules(ch: Changes, out: string[]) {
  return {
    index(key: string, m: number, what: string) {
      if (key in ch && !isIndex(ch[key], m)) out.push(`${key} ${repr(ch[key])} is not one of its ${m} ${what} (0-${m - 1}, or -1 for none)`)
    },
    count(key: string, m: number, says: string) {
      if (key in ch && !isCount(ch[key], m)) out.push(`${key} ${repr(ch[key])}: ${says}`)
    },
    indexes(key: string, m: number, says: string) {
      if (iter(or(ch[key], [])).some((x) => !isIndex(x, m))) out.push(`${key} ${str(ch[key])}: ${says}`)
    },
    long(key: string, n: number, says: string) {
      if (tooLong(get(ch, key), n)) out.push(`${key} "${str(ch[key])}" ${says}`)
    },
  }
}

const STATES: Record<ActorType, (a: Actor, ch: Changes) => string[]> = {
  service(a, ch) {
    const out: string[] = []
    rules(ch, out).count('done', count(a, 'checks'), `it has ${count(a, 'checks')} checks`)
    return out
  },
  table(a, ch) {
    const out: string[] = []
    const rows = count(a, 'rows')
    rules(ch, out).index('hi', rows, 'rows')
    const chips = or(ch.chips, {})
    for (const r of iter(chips)) {
      const ok = /^\d+$/.test(str(r)) && Number(r) < rows
      if (!ok) out.push(`chips for row ${repr(r)}: it has ${rows} rows`)
      else if (isObj(chips) && rowPx(get(a.rows[Number(r)] ?? {}, 'id'), or(chips[r as string], [])) > L.ROW_PX) {
        out.push(`chips ${str(chips[r as string])} make row ${r} wider than the box (${L.ROW_PX} px)`)
      }
    }
    return out
  },
  cluster(a, ch) {
    const out: string[] = []
    const r = rules(ch, out)
    const pods = count(a, 'pods')
    r.index('mark', pods, 'pods')
    for (const key of ['made', 'gone']) r.indexes(key, pods, `it has ${pods} pods`)
    const inner = isObj(a.inner) ? a.inner : undefined
    if (!inner && ['inner', 'innerMade', 'innerMark', 'innerGone'].some((x) => x in ch)) {
      out.push('inner/innerMade/innerMark/innerGone need an "inner" cluster on the actor')
    } else if (inner) {
      const m = size(or(inner.pods, []))
      r.index('innerMark', m, 'inner pods')
      for (const key of ['innerMade', 'innerGone']) r.indexes(key, m, `the inner cluster has ${m} pods`)
    }
    return out
  },
  browser(_a, ch) {
    return [null, '', ...L.LOCKS].includes(ch.lock ?? null) ? [] : [`lock ${repr(ch.lock)} is "ok" (a padlock) or "warn" ("Not secure")`]
  },
  file(a, ch) {
    const out: string[] = []
    const m = count(a, 'lines')
    rules(ch, out).count('show', m, `it has ${m} lines`)
    const hi = ch.hi
    const range = Array.isArray(hi) && hi.length === 2 && hi.every((x) => isIndex(x, m)) && hi[0] <= hi[1]
    if (hi !== undefined && hi !== null && !(isIndex(hi, m) || range)) out.push(`hi ${repr(hi)} is a line index or [first, last] of its ${m} lines`)
    const lim = truthy(a.from) ? L.FILE_NUM_CHARS : L.FILE_CHARS
    const text = or(ch.text, {})
    if (isObj(text)) {
      for (const [i, v] of Object.entries(text)) {
        if (!(/^\d+$/.test(i) && Number(i) < m)) out.push(`text for line ${repr(i)}: it has ${m} lines`)
        else if (tooLong(v, lim)) out.push(`text "${str(v)}" is ${len(str(v))} chars (max ${lim})`)
      }
    }
    return out
  },
  chat(a, ch) {
    const out: string[] = []
    const r = rules(ch, out)
    const m = count(a, 'messages')
    r.index('hi', m, 'messages')
    r.count('show', m, `it has ${m} messages`)
    return out
  },
  queue(a, ch) {
    const out: string[] = []
    const slots = or(a.slots, 6)
    const room = isInt(slots) ? Math.min(L.QUEUE_SLOTS, slots) : L.QUEUE_SLOTS
    rules(ch, out).count('fill', room, `it draws ${room} places`)
    return [...out, ...noteIssues(ch)]
  },
  gauge(_a, ch) {
    const out: string[] = []
    for (const key of ['used', 'want']) if (key in ch && !(isNumber(ch[key]) && Number(ch[key]) >= 0)) out.push(`${key} ${repr(ch[key])} is a number`)
    return [...noteIssues(ch), ...out]
  },
  terminal(a, ch) {
    const out: string[] = []
    const r = rules(ch, out)
    const m = count(a, 'lines')
    r.index('hi', m, 'lines')
    r.count('show', m, `it has ${m} lines`)
    return out
  },
  app(a, ch) {
    const out: string[] = []
    const r = rules(ch, out)
    if ('screen' in ch && !screensOf(a).includes(ch.screen)) out.push(`screen ${repr(ch.screen)} does not exist (${screensOf(a).join(', ')})`)
    if (![null, '', ...L.PANES].includes(ch.pane ?? null)) out.push(`pane ${repr(ch.pane)} is "picture" or "chat" (the detail page; none: cards and timeline)`)
    const chats = appList(a, 'chat', 'chat').length, cards = appList(a, 'cards', 'findings').length, events = appList(a, 'timeline', 'timeline').length
    r.count('chat', chats, `the actor has ${chats} chat messages`)
    r.index('newChat', chats, 'chat messages')
    if (tooLong(get(ch, 'typing'), L.APP_CHAT_CHARS)) out.push(`typing "${str(ch.typing)}" is over ${L.APP_CHAT_CHARS} chars`)
    for (const key of ['picture', 'desktop']) r.long(key, L.PICTURE_CHARS, `is over ${L.PICTURE_CHARS} chars`)
    const pages = or(a.pages, {})
    const most = Math.max(0, ...(isObj(pages) ? Object.values(pages).filter(isObj).map((p) => size(or(p.rows, []))) : []))
    r.count('rows', most, `its pages have at most ${most} rows`)
    r.index('hiRow', most, 'page rows')
    r.count('findings', cards, `it has ${cards} cards`)
    r.count('cards', cards, `it has ${cards} cards`)
    r.count('events', events, `it has ${events} timeline rows`)
    r.index('newFinding', cards, 'cards')
    r.index('newCard', cards, 'cards')
    r.index('newEvent', events, 'timeline rows')
    r.long('status', L.STATUS_CHARS, `is over ${L.STATUS_CHARS} chars`)
    if (![null, ...L.TONES].includes(ch.tone ?? null)) out.push(`tone ${repr(ch.tone)} is one of ${L.TONES.join(', ')}`)
    return out
  },
}

function noteIssues(ch: Changes): string[] {
  return tooLong(get(ch, 'note'), L.NOTE_CHARS) ? [`note "${str(ch.note)}" is ${len(str(ch.note))} chars (max ${L.NOTE_CHARS}; one line)`] : []
}

// ---------- the app actor: a window with a top bar, screens and its own pages ----------

/** The app screens there are: the three built in (also by their older names) and the actor's own `pages`. */
function screensOf(a: Actor): string[] {
  return [...L.SCREENS, ...L.SCREEN_ALIAS, ...(isObj(a.pages) ? Object.keys(a.pages) : [])]
}

/** One of the app actor's screen objects (`dialog`, `detail`, `signin`); {} when it has none. */
const screen = (a: Actor, key: string): Record<string, any> => (isObj(a[key]) ? a[key] : {})

/** A list of the app's detail page (`detail.<key>`), else the older flat field `old`. */
function appList(a: Actor, key: string, old: string): unknown[] {
  const d = screen(a, 'detail')[key]
  const v = d !== undefined && d !== null ? d : a[old]
  return Array.isArray(v) ? v : []
}

const SCREEN_FIELDS: [string, string[]][] = [
  ['dialog', ['tab', 'title', 'item', 'lines', 'button']],
  ['detail', ['tab', 'title', 'status', 'tone', 'empty', 'cards', 'timeline', 'picture', 'placeholder', 'chat']],
  ['signin', ['title', 'notice', 'provider', 'button']],
]

/** What in an app actor does not fit the window it draws, or is not what the engine reads. */
export function appIssues(a: Actor): Issue[] {
  const c = collector()
  const long = (what: string, v: unknown, n: number) => { if (tooLong(v, n)) c.problem(`${what} "${str(v)}" is ${len(str(v))} chars (max ${n})`) }
  const brand = str(or(a.brand, 'App'))
  const logo = str(or(a.logo, [...brand].slice(0, 1).join('')))
  if (len(logo) > 2) c.problem(`logo "${logo}" is 1 or 2 letters`)
  let tabs = get(a, 'tabs', [])
  if (!Array.isArray(tabs) || tabs.length > L.MAX_TABS || !tabs.every((x) => typeof x === 'string')) {
    c.problem(`"tabs" is a list of at most ${L.MAX_TABS} short names`)
    tabs = []
  }
  for (const x of tabs) long('tab', x, L.TAB_CHARS)
  const tabsPx = tabs.length ? tabs.reduce((w: number, x: string) => w + L.TAB_PX * len(x), 0) + L.TAB_GAP * (tabs.length - 1) : 0
  const top = (len(logo) > 1 ? 28 : 20) + 16 + L.BRAND_PX * len(brand) + tabsPx
  if (top > L.TOP_PX) c.problem(`brand "${brand}" and tabs ${repr(tabs)} are about ${pyRound(top)} px in the top bar (${L.TOP_PX} fit): shorter names or fewer tabs`)
  if (truthy(a.screen) && !screensOf(a).includes(a.screen)) c.problem(`screen ${repr(a.screen)} does not exist (${screensOf(a).join(', ')})`)
  const onTabs = (tab: unknown) => tab === undefined || tab === null || !tabs.length || tabs.includes(tab)
  for (const [key, allowed] of SCREEN_FIELDS) {
    if (key in a && !isObj(a[key])) c.problem(`"${key}" is an object (${sorted(allowed).join(', ')})`)
    const extra = Object.keys(screen(a, key)).filter((x) => !allowed.includes(x))
    if (extra.length) c.problem(`${key}: ${sorted(extra).join(', ')} is not read (it reads ${sorted(allowed).join(', ')})`)
    const tab = screen(a, key).tab
    if (!onTabs(tab)) c.problem(`${key} tab ${repr(tab)} is not one of its tabs ${repr(tabs)}`)
  }
  for (const [key, n] of L.OLD_CHARS) long(key, get(a, key), n)
  const dg = screen(a, 'dialog'), dt = screen(a, 'detail'), sg = screen(a, 'signin')
  for (const [key, n] of L.DIALOG_CHARS) long(`dialog ${key}`, get(dg, key), n)
  dialogLines(get(dg, 'lines', []), c)
  for (const [key, n] of L.DETAIL_CHARS) long(`detail ${key}`, get(dt, key), n)
  const title = str(or(dt.title, or(dg.item, or(a.test, 'Item'))))
  const status = str(or(dt.status, or(a.status, 'New')))
  if (len(title) + len(status) > L.TITLE_CHIP) c.problem(`detail title "${title}" and status "${status}" share one line: ${len(title) + len(status)} chars (max ${L.TITLE_CHIP})`)
  if (![null, ...L.TONES].includes(dt.tone ?? null)) c.problem(`detail tone ${repr(dt.tone)} is one of ${L.TONES.join(', ')}`)
  const cards = appList(a, 'cards', 'findings')
  if (cards.length > 2) c.warning(`${cards.length} cards; the detail page draws the first 2`)
  for (const x of cards) {
    if (!isObj(x)) c.problem('a card is {"sev"?: "low" | "medium" | "high" | "critical", "title": "…"}')
    else long('card', get(x, 'title'), L.CARD_CHARS)
  }
  for (const e of appList(a, 'timeline', 'timeline')) long('timeline row', e, L.TIMELINE_CHARS)
  for (const m of appList(a, 'chat', 'chat')) {
    if (!(isObj(m) && L.APP_CHAT_FROM.includes(m.from) && typeof m.text === 'string')) c.problem('a chat message is {"from": "me" | "them", "text": "…"}')
    else long('chat message', m.text, L.APP_CHAT_CHARS)
  }
  for (const [key, n] of L.SIGNIN_CHARS) long(`signin ${key}`, get(sg, key), n)
  const st = str(or(sg.title, `Sign in to ${brand}`))
  if (len(st) > L.SIGNIN_TITLE) c.problem(`the sign-in title "${st}" is ${len(st)} chars (max ${L.SIGNIN_TITLE}): a shorter brand or signin.title`)
  pageIssues(get(a, 'pages', {}), onTabs, tabs, c)
  return c.issues
}

function dialogLines(lines: unknown, c: Collector) {
  if (!Array.isArray(lines) || lines.length > L.DIALOG_LINES) {
    c.problem(`dialog "lines" is a list of at most ${L.DIALOG_LINES} [label, value] pairs`)
    return
  }
  for (const ln of lines) {
    if (!(Array.isArray(ln) && ln.length === 2)) c.problem('dialog: a line is ["label", "value"]')
    else if (tooLong(ln[0], L.LINE_KEY) || tooLong(ln[1], L.LINE_VALUE)) c.problem(`dialog line ${repr(ln)}: label max ${L.LINE_KEY} chars, value max ${L.LINE_VALUE}`)
  }
}

function pageIssues(pages: unknown, onTabs: (tab: unknown) => boolean, tabs: unknown[], c: Collector) {
  if (!isObj(pages)) {
    c.problem('"pages" is {name: {tab, title, chip?, tone?, banner?, rows: [[label, value]], button?}}')
    return
  }
  const long = (what: string, v: unknown, n: number) => { if (tooLong(v, n)) c.problem(`${what} "${str(v)}" is ${len(str(v))} chars (max ${n})`) }
  for (const [name, pg] of Object.entries(pages)) {
    if (L.SCREENS.includes(name) || L.SCREEN_ALIAS.includes(name) || !isObj(pg)) {
      c.problem(`page ${repr(name)} must be an object with a name other than ${[...L.SCREENS, ...L.SCREEN_ALIAS].join(', ')}`)
      continue
    }
    for (const [key, lim] of L.PAGE_CHARS) long(`page ${name} ${key}`, get(pg, key), lim)
    if (!onTabs(pg.tab)) c.problem(`page ${name} tab ${repr(pg.tab)} is not one of its tabs ${repr(tabs)}`)
    if (len(str(or(pg.title, name))) + len(str(get(pg, 'chip'))) > L.TITLE_CHIP) c.problem(`page ${name}: title and chip share one line (max ${L.TITLE_CHIP} chars together)`)
    if (![null, ...L.TONES].includes(pg.tone ?? null)) c.problem(`page ${name} tone ${repr(pg.tone)} is one of ${L.TONES.join(', ')}`)
    long(`page ${name} banner`, get(pg, 'banner'), L.PAGE_BANNER)
    const rows = get(pg, 'rows', [])
    const n = size(rows)
    if (n > L.PAGE_ROWS) c.problem(`page ${name} has ${n} rows (the page draws ${L.PAGE_ROWS})`)
    const banner = truthy(pg.banner), button = truthy(pg.button)
    if (n + Number(banner) + Number(button) > L.PAGE_ITEMS) {
      c.problem(`page ${name}: ${n} rows${banner ? ', a banner' : ''}${button ? ', a button' : ''}: ${L.PAGE_ITEMS} of these fit under the title`)
    }
    for (const r of iter(rows)) {
      if (!(Array.isArray(r) && r.length === 2)) c.problem(`page ${name}: a row is ["label", "value"]`)
      else if (tooLong(r[0], L.PAGE_KEY) || tooLong(r[1], L.PAGE_VALUE)) c.problem(`page ${name} row ${repr(r)}: label max ${L.PAGE_KEY} chars, value max ${L.PAGE_VALUE}`)
    }
  }
}
