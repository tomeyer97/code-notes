// The journey panel's home: every journey of the workspace, to find one and walk it (docs/journey-list.md). Search,
// filter chips, sections, a preview of the selected journey (beside the list when wide, unfolded under its row when
// narrow). The extension computes the list (src/journeyList.ts) with this home's search, filter and sort; we draw it.
// Needs common.js; styles in journey-home.css. Made by journey-map.js, which draws it in place of the journey while it
// is in front:
//   const home = JourneyHome({ app, post(m), render(), walk(key), hasJourney(), isTutorialUp() })
//   home.on  home.set(on)  home.open()  home.take(tourMessage)  home.preview(m)  home.beforeRender()  home.draw()
// What it posts (home, list, preview, refresh, hereAll; walk(key) is journey-map.js's walk) is listed with the panel's
// other messages: journey-map.js's header, and src/journeys/mapPanel.ts MapMessage, the extension's type.
;(function () {
  const { el, button, baseName, runKey, itemAt, rovingKeys } = window.common

  /** The orders the list can be sorted in (src/journeyList.ts sorts); `best` only while searching. */
  const SORTS = [
    ['best', 'Best match'],
    ['area', 'By area'],
    ['newest', 'Newest'],
    ['walked', 'Recently walked'],
    ['name', 'A–Z'],
  ]
  /** The preview lists this many steps (and every stale one), wide / narrow. */
  const PREVIEW_STEPS_WIDE = 14, PREVIEW_STEPS_NARROW = 8
  /** The list and the preview side by side from this panel width (px). */
  const WIDE_HOME = 700
  /** At most this many area chips. */
  const AREA_CHIPS = 8
  /** Typing in the search waits this long (ms) before the list is asked for (each key would ask again). */
  const LIST_DEBOUNCE_MS = 90

  /**
   * Where the keyboard goes back to after a render: the `data-f` of an element (focusNext, beforeRender, draw): a
   * row, a filter chip, a section's "Show n more", the search, the sort menu, the preview's Walk and Refresh.
   */
  const FOCUS = {
    row: (key) => `row:${key}`,
    chip: (id) => `chip:${id}`,
    more: (sectionId) => `more:${sectionId}`,
    search: 'search',
    sort: 'sort',
    walk: 'walk',
    refresh: 'refresh',
  }

  /** "⚠ Step 4 changed" for a row's tooltip. */
  const staleTip = (r) => {
    const n = r.staleSteps || []
    if (n.length) return `${n.length === 1 ? `Step ${n[0]}` : `Steps ${n.join(', ')}`} changed since it was written`
    return `${r.stale} step${r.stale === 1 ? '' : 's'} changed since it was written`
  }

  /** Text with the matched words marked. */
  function marked(text, hits) {
    const span = el('span', 't')
    if (!hits || !hits.length) { span.textContent = text; return span }
    const re = new RegExp(`(${hits.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    for (const part of text.split(re)) {
      if (!part) continue
      if (hits.some((h) => h.toLowerCase() === part.toLowerCase())) span.append(el('mark', '', part))
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

  /** The preview's button: back to where the walk is, on from where it was left, or from the start. */
  function walkLabel(r) {
    if (r.walking) return `Back to step ${r.resume}`
    if (r.resume > 1) return `Resume at ${r.resume}`
    return 'Walk'
  }

  window.JourneyHome = function (host) {
    const { app, post } = host

    // ---------- state ----------

    /** In front (the list over the journey), or not. */
    let on = false
    /** The list's model (src/journeyList.ts) and the journeys as the tour message lists them (`here`: the one open). */
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
    /** The keyboard goes here after the next render (a FOCUS name). */
    let focusNext = ''
    /** The list just came to the front: the keyboard into the search. */
    let focusSearch = false
    /** Where the keyboard was when the render began (beforeRender). */
    let was = { search: false, caret: 0, f: '' }

    /** Asks the extension for the list with this query and filter (and `extra`, e.g. a sort): at once with `extra`,
     *  else once typing pauses. */
    function sendList(extra) {
      clearTimeout(listTimer)
      const send = () => post({ type: 'list', ...hq, ...(extra || {}) })
      listTimer = setTimeout(send, extra ? 0 : LIST_DEBOUNCE_MS)
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
      if (v) focusSearch = true
      post({ type: 'home', on: v })
    }

    function select(k, focus, unfold) {
      if (!k || (k === sel && !unfold && !focus)) return
      sel = k
      if (unfold) unfolded = k
      fetchPreview(k)
      if (focus) focusNext = FOCUS.row(k)
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
        b.dataset.f = FOCUS.chip(id)
        if (title) b.title = title
        b.onclick = () => { hq.area = pressed ? '' : id; focusNext = FOCUS.chip(id); sendList({}) }
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
      const menu = el('select', 'hsort')
      menu.setAttribute('aria-label', 'Sort')
      menu.dataset.f = FOCUS.sort
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
        focusNext = FOCUS.sort
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
        searchEl.dataset.f = FOCUS.search
        searchEl.addEventListener('input', () => { hq.query = searchEl.value; sendList() })
      }
      if (searchEl.value !== hq.query) searchEl.value = hq.query
      return searchEl
    }

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
      const listEl = el('div', 'hlist')
      const keys = keysShown()
      if (!keys.includes(sel)) { sel = keys[0] || ''; if (sel) fetchPreview(sel) }
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
        if (sec.more) {
          const more = button('link hmore', `Show ${sec.more} more`, () => post({ type: 'hereAll' }))
          more.dataset.f = FOCUS.more(sec.id)
          listEl.append(more)
        }
      }
      if (m && !m.count) listEl.append(el('p', 'note', m.total ? 'Nothing matches.' : 'No journeys in this workspace.'))
      body.append(listEl)
      if (wide && sel && m) body.append(previewEl(m.rows[sel], true))
      h.append(body)
      return h
    }

    /** A journey's row: its title (matches marked) and marks, its question, one line about it. */
    function homeRow(r, k, sec) {
      const b = el('button', `jrow${k === sel ? ' sel' : ''}${r.here ? ' here' : ''}`)
      b.dataset.key = k
      b.dataset.f = FOCUS.row(k)
      b.tabIndex = k === sel ? 0 : -1
      b.setAttribute('aria-selected', String(k === sel))
      const t = el('span', 'jtop')
      t.append(marked(r.title, r.hits))
      if (r.start) t.append(el('span', 'jstart', 'Start here'))
      if (r.isNew) t.append(el('span', 'jnew', 'new'))
      if (r.walking || r.resume > 1) {
        const where = r.walking ? `Walking: step ${r.resume} of ${r.steps}` : `Left at step ${r.resume} of ${r.steps}`
        t.append(badge('jat', `${r.resume}/${r.steps}`, where))
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

    /** Walk (or Resume, Back to step n); Refresh when steps are stale. */
    function previewActions(r, hasStale) {
      const acts = el('div', 'pacts')
      const go = button('walkb', walkLabel(r), () => host.walk(r.key))
      go.dataset.f = FOCUS.walk
      acts.append(go)
      if (hasStale) {
        const refresh = () => post({ type: 'refresh', key: r.key })
        const rf = button('link refreshb', r.refreshing ? 'Refreshing…' : 'Refresh', refresh)
        rf.disabled = !!r.refreshing
        rf.title = 'The agent updates the stale steps of this journey (nothing else)'
        rf.dataset.f = FOCUS.refresh
        acts.append(rf)
      }
      return acts
    }

    // ---------- the keyboard ----------
    // "/" finds; Esc clears the search, then goes back to the journey; ↑ ↓ move between the rows (↓ from the search
    // into them, ↑ from the first back to it); Home End on a row; → unfolds the selected row; Enter walks it.

    document.addEventListener('keydown', (e) => {
      if (!on || host.isTutorialUp()) return
      const t = e.target
      const inSearch = t === searchEl
      const onRow = !!(t && t.classList && t.classList.contains('jrow'))
      // Nothing else has the keyboard (the page has it; a test's key is sent to the document).
      const onPage = t === document || t === document.body
      const keys = keysShown()
      const i = keys.indexOf(sel)
      const move = (d) => () => {
        if (inSearch) { if (d > 0) select(sel || keys[0], true); return }
        if (d < 0 && i <= 0 && searchEl) { searchEl.focus(); return }
        select(itemAt(keys, i + d), true)
      }
      runKey(e, {
        '/': !inSearch && (() => { if (searchEl) searchEl.focus() }),
        Escape: () => {
          if (hq.query) {
            hq.query = ''
            delete hq.searchSort
            if (searchEl) searchEl.value = ''
            focusNext = FOCUS.search
            sendList({})
          } else if (host.hasJourney()) { set(false); host.render() }
        },
        ArrowDown: (inSearch || onRow || onPage) && move(1),
        ArrowUp: (inSearch || onRow || onPage) && move(-1),
        Home: onRow && (() => select(keys[0], true)),
        End: onRow && (() => select(keys[keys.length - 1], true)),
        // (Only from a row or a test's key: a key on the bare page leaves it.)
        ArrowRight: (onRow || t === document) && (() => {
          if (!sel) return
          unfolded = sel
          fetchPreview(sel)
          focusNext = FOCUS.row(sel)
          host.render()
        }),
        // Enter on another button or the sort menu is its own.
        Enter: (inSearch || onRow || !t.closest || !t.closest('button, select')) && (() => host.walk(sel || keys[0])),
      })
    })

    return {
      get on() { return on },
      set,
      /** The list over the walk: the walk keeps its place; the journey it came from is selected (and in view). */
      open() {
        const self = (list.find((x) => x.here) || {}).key
        if (self) { sel = self; unfolded = self; fetchPreview(self) }
        set(true)
        window.scrollTo(0, 0)
        host.render()
        const row = self && app.querySelector('.jrow.sel')
        if (row) row.scrollIntoView({ block: 'nearest' })
      },
      /** A tour message's journeys (`list`) and the list's model (`home`), when it has them. */
      take(m) {
        if (m.list) list = m.list
        if (m.home) model = m.home
      },
      /** A journey for the preview. */
      preview(m) {
        previews[m.key] = m.journey
        staleOf[m.key] = m.stale || []
        if (on && m.key === sel) host.render()
      },
      /** Before the panel is emptied for a render: where the keyboard is (the list is drawn again under it). */
      beforeRender() {
        const a = document.activeElement
        const search = !!searchEl && a === searchEl
        was = { search, caret: search ? searchEl.selectionStart : 0, f: focusNext || (a && a.dataset && a.dataset.f) || '' }
        focusNext = ''
      },
      /** The home in the (emptied) panel; the keyboard back where it was: a row, a chip, the search (and its caret). */
      draw() {
        app.append(homeView())
        const back = was.f && was.f !== FOCUS.search && [...app.querySelectorAll('[data-f]')].find((x) => x.dataset.f === was.f)
        if (back) {
          back.focus({ preventScroll: true })
          back.scrollIntoView({ block: 'nearest' })
          focusSearch = false
        } else if (was.search || focusSearch || was.f === FOCUS.search) {
          searchEl.focus()
          if (was.search) searchEl.setSelectionRange(was.caret, was.caret)
          focusSearch = false
        }
      },
    }
  }
})()
