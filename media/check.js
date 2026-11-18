// The Check view (a webview in the Code Notes sidebar). Plain DOM, textContent only. Needs common.js (its QSTATE: how
// a question's state looks) and checkAnswer.js (the answer box under the selected question), loaded before it.
// In:
//   { type: 'check', view }     the view to draw (src/check/viewModel.ts CheckView, or null)
//   { type: 'test', click }     click this selector (integration tests)
//   anything else: the answer box's (media/checkAnswer.js)
// Out:
//   { type: 'ready' }  { type: 'error', message }
//   { type: 'open', id }  { type: 'select', id }        a question: opened; selected with the arrows
//   { type: 'retry' | 'modelSetting' | 'install' | 'pathSetting' }   writing the questions failed: what to do
//   { type: 'openMr' }  { type: 'openFile' }
//   { type: <the action's id> }   'start' | 'topUp' | 'scm' | 'commitPush' | 'pull' | 'merge' | 'openFile': the one button
//   { type: 'include', file, on }   a file ticked for Commit & push
//   { type: 'tour' | 'writeTour' }  the tour of the change: walk it, write it
//   { type: 'rendered', rows, overflow, height }   what is cut or sticks out (for tests)
//   and the answer box's (media/checkAnswer.js)
//   With checkAnswer.js's, these are src/check/viewMessages.ts CHECK_VIEW_REQUESTS and CHECK_VIEW_REPORTS (a name added
//   here goes there too; test/checkViewMessages.test.ts compares them).
;(function () {
  const { el, button, joinDots, baseName, connect, onMessages, rovingKeys, watched, WATCHED, overflowing, QSTATE } =
    window.common
  /** The answer box (checkAnswer.js): drawn under the selected row; keeps the keyboard across a render. */
  const answer = window.checkAnswer
  const { post } = connect()
  const app = document.getElementById('app')
  /** The view (src/check/viewModel.ts CheckView), or null: no repository. */
  let V

  function render() {
    const active = document.activeElement
    const focused = active && active.dataset ? active.dataset.id : undefined
    const keep = answer.before()
    app.textContent = ''
    if (!V) {
      app.append(el('p', 'muted', 'Open a git repository to check your understanding of a change.'))
      report()
      return
    }
    app.append(header(V))
    if (V.busy) app.append(watched(el('p', 'busy', V.busy)))
    // The one button right under where the check stands (never below the questions, out of sight).
    if (V.action) app.append(footer(V))
    if (V.tour) app.append(tourLink(V.tour))
    if (V.rows.length) {
      const ol = el('ol', 'rows')
      ol.setAttribute('aria-label', 'Questions')
      for (const r of V.rows) ol.append(row(r))
      app.append(ol)
    }
    if (focused) {
      const again = app.querySelector(`button.open[data-id="${CSS.escape(focused)}"]`)
      if (again) again.focus()
    }
    answer.after(keep)
    report()
  }

  /** The tour of the change: one quiet link (walking it is optional; the rows go straight to a question), or one
   *  muted line while it is written. */
  function tourLink(tour) {
    if (!tour.action) return watched(el('p', 'busy tour', tour.label))
    const type = tour.action === 'walk' ? 'tour' : 'writeTour'
    return watched(button('link tour', tour.label, () => post({ type })))
  }

  /** Where the check stands: its title, the rule, who, a notice; a failure; what setup said; a merge request's link. */
  function header(V) {
    const h = el('header', `tone-${V.tone}`)
    h.append(watched(el('p', 'title', V.title)))
    if (V.line) h.append(watched(el('p', 'line', V.line)))
    if (V.who) h.append(watched(el('p', 'who', V.who)))
    if (V.notice) h.append(watched(el('p', 'notice', V.notice)))
    if (V.failed) h.append(failure(V.failed))
    if (V.said) h.append(watched(el('p', 'setup said', V.said)))
    // Pushed a branch without a merge request: the link the push printed.
    if (V.mr) {
      const p = watched(el('p', 'mr'))
      const b = button('link', 'Open merge request ↗', () => post({ type: 'openMr' }))
      b.title = V.mr
      p.append(b)
      h.append(p)
    }
    return h
  }

  /** Writing the questions failed: why, and Retry (the model setting when it was the model). Claude Code not found:
   *  install it, or say where it is; meanwhile a reviewer's approval waives the check. */
  function failure(f) {
    const p = watched(el('p', 'failed'))
    const retry = button('link', 'Retry', () => post({ type: 'retry' }))
    if (f.path) {
      const install = button('link', 'Install ↗', () => post({ type: 'install' }))
      const where = button('link', 'Set its path', () => post({ type: 'pathSetting' }))
      const waive = el('span', 'waive', " (or a reviewer's approval waives the check)")
      p.append(`${f.text} `, ...joinDots(install, where, retry), waive)
    } else if (f.setting) {
      const settings = button('link', 'Settings', () => post({ type: 'modelSetting' }))
      p.append(`${f.text} `, ...joinDots(retry, settings))
    } else p.append(`${f.text} `, retry)
    return p
  }

  /** The one button. Commit & push: what it commits, and a file to tick (a TODO the check added). A conflict: beside
   *  Keep both answers, the file itself. */
  function footer(V) {
    const f = el('footer')
    if (V.commits) f.append(watched(el('p', 'commits', V.commits)))
    for (const a of V.also || []) {
      const l = watched(el('label', 'also'))
      const c = el('input')
      c.type = 'checkbox'
      c.checked = a.on
      c.dataset.file = a.file
      c.onchange = () => post({ type: 'include', file: a.file, on: c.checked })
      l.append(c, el('span', '', a.label))
      f.append(l)
    }
    f.append(watched(button('primary', V.action.label, () => post({ type: V.action.id }))))
    if (V.action.id === 'merge') f.append(' ', button('link open-file', 'Open the file', () => post({ type: 'openFile' })))
    return f
  }

  /** File names only: lines are what a click shows. */
  const fileName = (where) => baseName(where).replace(/:\d+(-\d+)?$/, '')

  /** A question row's words: its tooltip (the whole question and where), its meta line, what a screen reader says. */
  function describe(r) {
    const step = r.step ? ` · after step ${r.step} of the tour` : ''
    const also = r.also.length ? `\nAlso: ${r.also.join(', ')}` : ''
    const files = [fileName(r.where), ...r.also.map((a) => `+ ${fileName(a)}`)]
    const metaParts = [r.kind, r.step ? `step ${r.step}` : '', ...files, r.word]
    const said = r.word || (r.state === 'pass' ? 'passed' : 'to answer')
    return {
      title: `${r.text}\n${r.kind}${step} · ${r.where}${also}`,
      meta: metaParts.filter(Boolean).join(' · '),
      aria: `${r.n}. ${r.text.replace(/`/g, '')} (${said})`,
    }
  }

  /** A question: its state's icon, its text (`name` shown as code), the meta line, a flag; the answer box under the
   *  selected one (media/checkAnswer.js). */
  function row(r) {
    const li = el('li', `row ${r.state}`)
    const d = describe(r)
    const b = button('open', undefined, () => post({ type: 'open', id: r.id }))
    b.title = d.title
    b.dataset.id = r.id
    const icon = el('span', 'icon', (Object.hasOwn(QSTATE, r.state) && QSTATE[r.state].icon) || '○')
    icon.setAttribute('aria-hidden', 'true')
    const body = el('span', 'body')
    const text = watched(el('span', 'text'))
    r.text.split('`').forEach((part, k) => { if (part) text.append(k % 2 ? el('code', null, part) : part) })
    body.append(text, watched(el('span', 'meta', d.meta)))
    if (r.flag) body.append(watched(el('span', 'flag', `⚠ ${r.flag}`)))
    b.setAttribute('aria-label', d.aria)
    b.append(icon, body)
    li.append(b)
    if (V.answer && V.answer.id === r.id) li.append(answer.box(V.answer, r, post))
    return li
  }

  // ↑ ↓ Home End between the questions; Enter or Space opens one (a button).
  app.addEventListener('keydown', (e) => {
    const rows = [...app.querySelectorAll('button.open')]
    const i = rows.indexOf(document.activeElement)
    if (i < 0) return
    // The arrows select a question: its answer box shows under it (Enter, a click or Tab goes into it).
    const selectRow = (r) => {
      r.focus()
      post({ type: 'select', id: r.dataset.id })
    }
    rovingKeys(e, rows, i, { prev: 'ArrowUp', next: 'ArrowDown' }, selectRow)
  })

  // What a person would notice: anything wider than the view, or a cut line (in the elements made watched()).
  function report() {
    requestAnimationFrame(() => {
      const overflow = overflowing(app, WATCHED, (e) => `${e.className || e.tagName}: ${e.textContent.slice(0, 30)}`)
      post({ type: 'rendered', rows: V ? V.rows.length : 0, overflow, height: document.documentElement.scrollHeight })
    })
  }

  // Any other message is the answer box's (checkAnswer.js).
  onMessages({
    check(m) { V = m.view; render() },
    test(m) {
      if (!m.click) return
      const t = document.querySelector(m.click)
      if (t) t.click()
    },
  }, (m) => answer.message(m, post))
  post({ type: 'ready' })
})()
