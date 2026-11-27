// The journey panel's home: every journey of the workspace, to find one and walk it (docs/journey-list.md). Search,
// filter chips, sections, a preview of the selected journey (beside the list when wide, unfolded under its row when
// narrow). The extension computes the list (src/core/list/journeyList.ts) with this home's search, filter and sort; we
// draw it. Styles in journey-home.css; its words in home/text.js. journey-map.js makes it and draws it in place of the
// journey while it is in front; what it posts is typed by src/protocol/map.ts FromMap.
import { el, button, baseName, runKey, itemAt, rovingKeys } from './common.js'
import { SORTS, staleTip, walkLabel, inProgress, podcastBadge, escapeRegExp } from './home/text.js'

/**
 * What the home needs of the page (journey-map.js): its root element (emptied and drawn again on every render),
 * posting a message, rendering the panel again, walking a journey, whether a journey is open (Esc goes back to it),
 * whether the tutorial is up (it has the keyboard then).
 * @typedef {{ app: HTMLElement, post(m: import('../src/protocol/map').FromMap): void, render(): void,
 *   walk(key: string): void, hasJourney(): boolean, isTutorialUp(): boolean }} HomeHost
 */

/** The preview lists this many steps (and every stale one), wide / narrow. */
const PREVIEW_STEPS_WIDE = 14, PREVIEW_STEPS_NARROW = 8
/** The list and the preview side by side from this panel width (px). */
const WIDE_HOME = 700
/** At most this many area chips. */
const AREA_CHIPS = 8
/** Typing in the search waits this long (ms) before the list is asked for (each key would ask again). */
const LIST_DEBOUNCE_MS = 90

/**
 * Where the keyboard goes back to after a render (the panel draws the home anew): an element's focus key, set with
 * FOCUS.tag and found with FOCUS.find. A row, a filter chip, a section's "Show n more", the search, the sort menu,
 * the preview's Walk and Refresh.
 */
const FOCUS = {
  row: (key) => `row:${key}`,
  chip: (id) => `chip:${id}`,
  more: (sectionId) => `more:${sectionId}`,
  search: 'search',
  sort: 'sort',
  walk: 'walk',
  refresh: 'refresh',
  /** Element `e` marked with focus key `key`; returns `e`. @template {HTMLElement} E @param {E} e @returns {E} */
  tag: (e, key) => { e.dataset.f = key; return e },
  /** The focus key of element `e` ('' none). @param {Element | null} e */
  of: (e) => (e instanceof HTMLElement && e.dataset.f) || '',
  /** The element in `root` with focus key `key`. @param {HTMLElement} root @returns {HTMLElement | undefined} */
  find: (root, key) => [.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-f]'))].find((x) => x.dataset.f === key),
}

/** Text with the matched words (`hits`) marked. */
function marked(text, hits) {
  const span = el('span', 't')
  if (!hits || !hits.length) { span.textContent = text; return span }
  const re = new RegExp(`(${hits.map(escapeRegExp).join('|')})`, 'gi')
  const isHit = new Set(hits.map((h) => h.toLowerCase()))
  for (const part of text.split(re)) {
    if (!part) continue
    if (isHit.has(part.toLowerCase())) span.append(el('mark', '', part))
    else span.append(document.createTextNode(part))
  }
  return span
}

/** A small mark on a row (its tooltip says what it means). */
function badge(cls, text, title) {
  const x = el('span', cls, text)
  x.title = title
  return x
}

/** @param {HomeHost} host */
export function JourneyHome(host) {
  const { app, post } = host

  // ---------- state ----------

  /** In front (the list over the journey), or not. */
  let on = false
  /** The list's model (src/core/list/journeyList.ts) and the journeys as the tour message lists them (`here`: the one open). */
  let model
  let list = []
  /** The query and filter chip, sent to the extension, which answers with a new model. */
  const hq = { query: '', kind: 'all', area: '' }
  /** The selected row (previewed); the row unfolded in a narrow panel; journeys fetched for the preview (+ their
   *  stale steps: [{ n, when }]). */
  let sel = ''
  let unfolded = ''
  const previews = Object.create(null)
  const staleOf = Object.create(null)
  /** The search box: one, kept across renders (it keeps the caret). */
  let searchEl
  let listTimer = 0
  const focus = focusKeeper(app, () => searchEl)

  /** Asks the extension for the list with this query and filter (and `extra`, e.g. a sort): at once with `extra`,
   *  else once typing pauses. */
  function sendList(extra) {
    clearTimeout(listTimer)
    const send = () => post({ type: 'list', ...hq, ...(extra || {}) })
    listTimer = window.setTimeout(send, extra ? 0 : LIST_DEBOUNCE_MS)
  }
  /** Visible keys in order (the keyboard moves through these). */
  const keysShown = () => (model ? [...new Set(model.sections.flatMap((s) => s.keys))] : [])
  /** Asks for journey `k` for its preview, unless it is here already (or not in the list). */
  function fetchPreview(k) {
    const r = model && model.rows[k]
    if (r && !previews[k]) post({ type: 'preview', key: k })
  }

  function set(v) {
    if (on === v) return
    on = v
    if (v) focus.toSearch()
    post({ type: 'home', on: v })
    if (v) keepSelectionShown()
  }

  /** The selection on a row the list shows (the first when it is not), its preview asked for. Run when the list
   *  changes or comes to the front, not while drawing. */
  function keepSelectionShown() {
    const keys = keysShown()
    if (keys.includes(sel)) return
    sel = keys[0] || ''
    if (sel) fetchPreview(sel)
  }

  function select(k, focusIt, unfold) {
    if (!k || (k === sel && !unfold && !focusIt)) return
    sel = k
    if (unfold) unfolded = k
    fetchPreview(k)
    if (focusIt) focus.after(FOCUS.row(k))
    host.render()
  }

  // ---------- drawing ----------

  /** Filter chips: one Tab stop, ← → move between them (a toolbar); the sort menu at the end. */
  function chipBar(m) {
    const bar = el('div', 'chips')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'Filter')
    const chips = []
    const chip = (id, label, title) => {
      const pressed = hq.area === id
      const b = el('button', `chip${pressed ? ' on' : ''}`, label)
      b.setAttribute('aria-pressed', String(pressed))
      FOCUS.tag(b, FOCUS.chip(id))
      if (title) b.title = title
      b.onclick = () => { hq.area = pressed ? '' : id; focus.after(FOCUS.chip(id)); sendList({}) }
      chips.push(b)
      bar.append(b)
    }
    if (m.file) chip('here', `In ${baseName(m.file)}`, m.file)
    if (m.staleCount) chip('stale', `Stale ${m.staleCount}`, 'Journeys whose code changed since they were written')
    for (const a of m.areas.slice(0, AREA_CHIPS)) chip(a.name, a.name, `${a.count} in ${a.name}`)
    const tab = chips.find((b) => b.classList.contains('on')) || chips[0]
    for (const b of chips) b.tabIndex = b === tab ? 0 : -1
    bar.addEventListener('keydown', (e) => {
      const i = chips.indexOf(document.activeElement)
      if (i < 0) return
      // The chip moved to is the bar's one Tab stop.
      const moveTo = (t) => {
        for (const b of chips) b.tabIndex = b === t ? 0 : -1
        t.focus()
      }
      rovingKeys(e, chips, i, { prev: 'ArrowLeft', next: 'ArrowRight' }, moveTo, true)
    })
    bar.append(sortMenu(m))
    if (!chips.length) bar.removeAttribute('role')
    return bar
  }

  /** The sort menu. A search orders by best match unless another order is picked for it (the list's own sort stays). */
  function sortMenu(m) {
    const menu = FOCUS.tag(el('select', 'hsort'), FOCUS.sort)
    menu.setAttribute('aria-label', 'Sort')
    const searching = !!m.query
    const current = searching ? m.searchSort || 'best' : m.sort
    for (const [id, label] of SORTS) {
      if (id === 'best' && !searching) continue
      const o = el('option', '', label)
      o.value = id
      if (current === id) o.selected = true
      menu.append(o)
    }
    menu.onchange = () => {
      focus.after(FOCUS.sort)
      if (searching) { hq.searchSort = menu.value; sendList({}) }
      else sendList({ sort: menu.value })
    }
    return menu
  }

  /** The search box, made once. */
  function search() {
    if (!searchEl) {
      searchEl = el('input', 'hsearch')
      searchEl.type = 'search'
      searchEl.placeholder = 'Search journeys'
      searchEl.setAttribute('aria-label', 'Search journeys (/)')
      FOCUS.tag(searchEl, FOCUS.search)
      searchEl.addEventListener('input', () => { hq.query = searchEl.value; sendList() })
    }
    if (searchEl.value !== hq.query) searchEl.value = hq.query
    return searchEl
  }

  /** The home: its heading and count, the search, the chips and sort, the list and (wide) the preview. */
  function homeView() {
    const m = model
    const h = el('div', 'home')
    const wide = app.clientWidth >= WIDE_HOME
    h.classList.toggle('wide', wide)
    const top = el('div', 'htop')
    top.append(el('h1', 'q', 'Journeys'))
    if (m) top.append(el('span', 'hcount', m.query || m.area ? `${m.count} of ${m.total}` : String(m.total)))
    h.append(top)
    h.append(search())
    if (m) h.append(chipBar(m))
    if (m && m.fallback) h.append(el('p', 'hnote', m.fallback.note))
    const body = el('div', 'hbody')
    body.append(sectionsEl(m, wide))
    if (wide && sel && m) body.append(previewEl(m.rows[sel], true))
    h.append(body)
    return h
  }

  /** The list: each section's rows (narrow: the selected one unfolded), its "Show n more"; a note when it is empty. */
  function sectionsEl(m, wide) {
    const listEl = el('div', 'hlist')
    for (const sec of m ? m.sections : []) {
      listEl.append(el('h2', 'hsec', sec.label))
      const ul = el('ul', 'jlist')
      for (const k of sec.keys) {
        const li = el('li')
        li.append(homeRow(m.rows[k], k, sec))
        // Narrow: the selected row unfolds its steps and its Walk button.
        if (!wide && k === sel && k === unfolded) li.append(previewEl(m.rows[k], false))
        ul.append(li)
      }
      listEl.append(ul)
      if (sec.more) listEl.append(FOCUS.tag(button('link hmore', `Show ${sec.more} more`, () => post({ type: 'hereAll' })), FOCUS.more(sec.id)))
    }
    if (m && !m.count) listEl.append(el('p', 'note', m.total ? 'Nothing matches.' : 'No journeys in this workspace.'))
    return listEl
  }

  /** A journey's row: its title (matches marked) and marks, its question, one line about it. */
  function homeRow(r, k, sec) {
    const b = el('button', `jrow${k === sel ? ' sel' : ''}${r.here ? ' here' : ''}`)
    b.dataset.key = k
    FOCUS.tag(b, FOCUS.row(k))
    b.tabIndex = k === sel ? 0 : -1
    b.setAttribute('aria-selected', String(k === sel))
    const t = el('span', 'jtop')
    t.append(marked(r.title, r.hits))
    // "Start here" is for a journey not begun yet: one in progress says where it is instead.
    if (r.start && !inProgress(r)) t.append(el('span', 'jstart', 'Start here'))
    if (r.isNew) t.append(el('span', 'jnew', 'new'))
    if (inProgress(r)) {
      const where = r.walking ? `Walking: step ${r.resume} of ${r.steps}` : `Left at step ${r.resume} of ${r.steps}`
      t.append(badge('jat', `${r.resume}/${r.steps}`, where))
    }
    // A podcast: its length, or that it is being listened to (paused at …).
    if (r.podcast) {
      const { text, tip } = podcastBadge(r.podcast)
      t.append(badge(`jpod${r.podcast.playing ? ' on' : ''}`, text, tip))
    }
    if (r.stale) {
      const x = badge('jstale', '⚠', staleTip(r))
      x.setAttribute('aria-label', `Stale: ${staleTip(r)}`)
      t.append(x)
    }
    b.append(t)
    if (r.question && r.question.toLowerCase() !== r.title.toLowerCase()) b.append(el('span', 'jq', r.question))
    b.append(el('span', 'jmeta', sec.id === 'here' && r.hereText ? r.hereText : r.meta))
    b.onclick = () => select(k, false, true)
    b.ondblclick = () => host.walk(k)
    return b
  }

  /** Row `r`'s stale steps: step number → when its code changed ('' until the preview's journey says). */
  function staleSteps(r) {
    const when = new Map((staleOf[r.key] || []).map((s) => [s.n, s.when]))
    return new Map((r.staleSteps || []).map((n) => [n, when.get(n) || '']))
  }

  /** What a row holds: its question (wide), its steps with the stale ones marked, Walk / Resume, Refresh. */
  function previewEl(r, wide) {
    const p = el(wide ? 'aside' : 'div', wide ? 'hprev' : 'hunfold')
    if (wide) {
      p.append(el('h2', 'pt', r.title))
      if (r.question) p.append(el('p', 'pq', r.question))
    }
    const stale = staleSteps(r)
    const max = wide ? PREVIEW_STEPS_WIDE : PREVIEW_STEPS_NARROW
    const ol = el('ol', 'psteps')
    r.stepTitles.forEach((t, i) => {
      const n = i + 1
      if (i >= max && !stale.has(n)) return
      const li = el('li', stale.has(n) ? 'stale' : '', t)
      li.value = n
      if (stale.has(n)) {
        const when = stale.get(n)
        li.append(el('span', 'pwhen', `⚠ changed${when ? ` · ${when}` : ''}`))
      }
      ol.append(li)
    })
    if (r.stepTitles.length > max) ol.append(el('li', 'more', `+${r.stepTitles.length - max} more`))
    p.append(ol)
    if (stale.size && stale.size < r.steps) {
      p.append(el('p', 'pnote', `The other ${r.steps - stale.size} still match the code.`))
    }
    p.append(previewActions(r, stale.size > 0))
    return p
  }

  /** Walk, or Resume · n/N; Refresh when steps are stale. */
  function previewActions(r, hasStale) {
    const acts = el('div', 'pacts')
    const go = button('walkb', walkLabel(r), () => host.walk(r.key))
    FOCUS.tag(go, FOCUS.walk)
    acts.append(go)
    if (hasStale) {
      const refresh = () => post({ type: 'refresh', key: r.key })
      const rf = button('link refreshb', r.refreshing ? 'Refreshing…' : 'Refresh', refresh)
      rf.disabled = !!r.refreshing
      rf.title = 'The agent updates the stale steps of this journey (nothing else)'
      FOCUS.tag(rf, FOCUS.refresh)
      acts.append(rf)
    }
    return acts
  }

  // ---------- the keyboard ----------
  // "/" finds; Esc clears the search, then goes back to the journey; ↑ ↓ move between the rows (↓ from the search
  // into them, ↑ from the first back to it); Home End on a row; → unfolds the selected row; Enter walks it.

  /** Key `e` when the home is in front: whether it was the home's. @param {KeyboardEvent} e */
  function ownsKey(e) {
    if (!on || host.isTutorialUp()) return false
    /** @type {any} The element with the keyboard, or the document. */
    const t = e.target
    const inSearch = t === searchEl
    const onRow = !!(t && t.classList && t.classList.contains('jrow'))
    // Nothing else has the keyboard (the page has it; the panel's test hook sends its keys to the document).
    const onPage = t === document || t === document.body
    const keys = keysShown()
    const i = keys.indexOf(sel)
    const move = (d) => () => {
      if (inSearch) { if (d > 0) select(sel || keys[0], true); return }
      if (d < 0 && i <= 0 && searchEl) { searchEl.focus(); return }
      select(itemAt(keys, i + d), true)
    }
    return runKey(e, {
      '/': !inSearch && (() => { if (searchEl) searchEl.focus() }),
      Escape: () => {
        if (hq.query) {
          hq.query = ''
          delete hq.searchSort
          if (searchEl) searchEl.value = ''
          focus.after(FOCUS.search)
          sendList({})
        } else if (host.hasJourney()) { set(false); host.render() }
      },
      ArrowDown: (inSearch || onRow || onPage) && move(1),
      ArrowUp: (inSearch || onRow || onPage) && move(-1),
      Home: onRow && (() => select(keys[0], true)),
      End: onRow && (() => select(keys[keys.length - 1], true)),
      // (Only from a row or the test hook's key: a key on the bare page leaves it.)
      ArrowRight: (onRow || t === document) && (() => {
        if (!sel) return
        unfolded = sel
        fetchPreview(sel)
        focus.after(FOCUS.row(sel))
        host.render()
      }),
      // Enter on another button or the sort menu is its own.
      Enter: (inSearch || onRow || !t.closest || !t.closest('button, select')) && (() => host.walk(sel || keys[0])),
    })
  }
  document.addEventListener('keydown', ownsKey)

  return {
    get on() { return on },
    set,
    /** The list over the walk: the walk keeps its place; the journey it came from is selected (and in view). */
    open() {
      const self = (list.find((x) => x.here) || {}).key
      if (self) { sel = self; unfolded = self; fetchPreview(self) }
      set(true)
      keepSelectionShown()
      window.scrollTo(0, 0)
      host.render()
      const row = self && app.querySelector('.jrow.sel')
      if (row) row.scrollIntoView({ block: 'nearest' })
    },
    /** A tour message's journeys (`list`) and the list's model (`home`), when it has them. */
    take(m) {
      if (m.list) list = m.list
      if (m.home) model = m.home
      if (on) keepSelectionShown()
    },
    /** A journey for the preview. */
    preview(m) {
      previews[m.key] = m.journey
      staleOf[m.key] = m.stale || []
      if (on && m.key === sel) host.render()
    },
    /** Before the panel is emptied for a render: where the keyboard is (the list is drawn again under it). */
    beforeRender: () => focus.remember(),
    /** The home in the (emptied) panel; the keyboard back where it was: a row, a chip, the search (and its caret). */
    draw() {
      app.append(homeView())
      focus.restore()
    },
  }
}

/**
 * The keyboard across the panel's renders (it empties the panel and draws the home anew, so the element that had
 * the keyboard is gone): where it was before the render, or where an action sends it (`after`, a FOCUS key), is
 * found again after it; the search (and its caret) when the home just came to the front.
 * @param {HTMLElement} app @param {() => HTMLInputElement | undefined} searchBox
 */
function focusKeeper(app, searchBox) {
  /** The keyboard goes here after the next render (a FOCUS key). */
  let next = ''
  /** The home just came to the front: the keyboard into the search. */
  let toSearch = false
  /** Where the keyboard was when the render began. */
  let was = { search: false, caret: 0, f: '' }
  return {
    after(key) { next = key },
    toSearch() { toSearch = true },
    remember() {
      const a = document.activeElement
      const box = searchBox()
      const search = !!box && a === box
      was = { search, caret: search && box ? box.selectionStart || 0 : 0, f: next || FOCUS.of(a) }
      next = ''
    },
    restore() {
      const back = was.f && was.f !== FOCUS.search && FOCUS.find(app, was.f)
      const box = searchBox()
      if (back) {
        back.focus({ preventScroll: true })
        back.scrollIntoView({ block: 'nearest' })
        toSearch = false
      } else if (box && (was.search || toSearch || was.f === FOCUS.search)) {
        box.focus()
        if (was.search) box.setSelectionRange(was.caret, was.caret)
        toSearch = false
      }
    },
  }
}
