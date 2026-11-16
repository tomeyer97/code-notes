// The Check view (a webview in the Code Notes sidebar). Plain DOM, textContent only.
// In:  { type: 'check', view } (src/checkModel.ts CheckView, or null)   { type: 'test', click: selector }
// Out: { type: 'setup' | 'setupHide' | 'openMr' | 'pull' | 'install' | 'pathSetting' | 'modelSetting' | 'retry' } { type: 'ready' } { type: 'open', id } { type: 'select', id } { type: 'start' | 'topUp' | 'scm' | 'commitPush' | 'tour' | 'writeTour' } { type: 'include', file, on }
//      (and the answer box's: media/checkAnswer.js)
//      { type: 'rendered', rows, overflow, height } (what is cut or sticks out, for tests) { type: 'error', message }
;(function () {
  const vscode = acquireVsCodeApi()
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) }))
  const app = document.getElementById('app')
  const ICON = { todo: '○', ungraded: '…', pass: '✓', restated: '✓', retry: '↻', explained: '·' }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const post = (m) => vscode.postMessage(m)
  let V

  function render() {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : undefined
    const keep = window.checkAnswer && window.checkAnswer.before()
    app.textContent = ''
    if (!V) { app.append(el('p', 'muted', 'Open a git repository to check your understanding of a change.')); report(); return }
    const h = el('header', `tone-${V.tone}`)
    h.append(el('p', 'title', V.title))
    if (V.line) h.append(el('p', 'line', V.line))
    if (V.who) h.append(el('p', 'who', V.who))
    if (V.notice) h.append(el('p', 'notice', V.notice))
    // Writing the questions failed: why, and Retry (the model setting when it was the model).
    if (V.failed) {
      const p = el('p', 'failed'), r = el('button', 'link', 'Retry')
      r.onclick = () => post({ type: 'retry' })
      p.append(`${V.failed.text} `, r)
      if (V.failed.setting) { const s = el('button', 'link', 'Settings'); s.onclick = () => post({ type: 'modelSetting' }); p.append(' · ', s) }
      // Claude Code not found: install it, or say where it is; meanwhile a reviewer's approval waives the check.
      if (V.failed.path) {
        const i = el('button', 'link', 'Install ↗'), s = el('button', 'link', 'Set its path')
        i.onclick = () => post({ type: 'install' }); s.onclick = () => post({ type: 'pathSetting' })
        p.textContent = ''
        p.append(`${V.failed.text} `, i, ' · ', s, ' · ', r, el('span', 'waive', " (or a reviewer's approval waives the check)"))
      }
      h.append(p)
    }
    // Once per repository, the person's choice: the lines that collapse check files in diffs, in a commit of their own.
    if (V.setup) {
      const p = el('p', 'setup'), b = el('button', 'link', 'Set up'), x = el('button', 'link hide', 'Hide')
      b.onclick = () => post({ type: 'setup' }); x.onclick = () => post({ type: 'setupHide' }); x.title = "Don't show this again here"
      b.title = 'Adds .gitattributes and .ignore lines in a commit of their own'
      p.append(`${V.setup} `, b, ' · ', x); h.append(p)
    }
    if (V.said) h.append(el('p', 'setup said', V.said))
    // Pushed a branch without a merge request: the link the push printed.
    if (V.mr) { const p = el('p', 'mr'), b = el('button', 'link', 'Open merge request ↗'); b.title = V.mr; b.onclick = () => post({ type: 'openMr' }); p.append(b); h.append(p) }
    app.append(h)
    if (V.busy) app.append(el('p', 'busy', V.busy))
    // The one button right under where the check stands (never below the questions, out of sight).
    if (V.action) {
      const f = el('footer')
      // Commit & push: what it commits, and a TODO the check added, only when ticked.
      if (V.commits) f.append(el('p', 'commits', V.commits))
      for (const a of V.also || []) {
        const l = el('label', 'also'), c = el('input')
        c.type = 'checkbox'; c.checked = a.on; c.dataset.file = a.file
        c.onchange = () => post({ type: 'include', file: a.file, on: c.checked })
        l.append(c, el('span', '', a.label)); f.append(l)
      }
      const b = el('button', 'primary', V.action.label); b.onclick = () => post({ type: V.action.id }); f.append(b)
      // A conflict: beside Keep both answers, the file itself.
      if (V.action.id === 'merge') { const o = el('button', 'link open-file', 'Open the file'); o.onclick = () => post({ type: 'openFile' }); f.append(' ', o) }
      app.append(f)
    }
    // The tour of the change: one quiet link (walking it is optional; the rows go straight to a question).
    if (V.tour && V.tour.action) { const t = el('button', 'link tour', V.tour.label); t.onclick = () => post({ type: V.tour.action === 'walk' ? 'tour' : 'writeTour' }); app.append(t) }
    else if (V.tour) app.append(el('p', 'busy tour', V.tour.label))
    if (V.rows.length) {
      const ol = el('ol', 'rows')
      ol.setAttribute('aria-label', 'Questions')
      for (const r of V.rows) {
        const li = el('li', `row ${r.state}`)
        const b = el('button', 'open')
        b.title = `${r.text}\n${r.kind}${r.step ? ` · after step ${r.step} of the tour` : ''} · ${r.where}${r.also.length ? `\nAlso: ${r.also.join(', ')}` : ''}`
        b.dataset.id = r.id
        b.onclick = () => post({ type: 'open', id: r.id })
        const icon = el('span', 'icon', ICON[r.state] || '○')
        icon.setAttribute('aria-hidden', 'true')
        const body = el('span', 'body')
        // File names only: lines are what a click shows.
        const name = (w) => w.split('/').pop().replace(/:\d+(-\d+)?$/, '')
        const meta = [r.kind, r.step ? `step ${r.step}` : '', name(r.where), ...r.also.map((a) => `+ ${name(a)}`), r.word].filter(Boolean).join(' · ')
        // `name` in a question: shown as code (textContent only).
        const text = el('span', 'text')
        r.text.split('`').forEach((part, k) => { if (part) text.append(k % 2 ? el('code', null, part) : part) })
        body.append(text, el('span', 'meta', meta))
        if (r.flag) body.append(el('span', 'flag', `⚠ ${r.flag}`))
        b.setAttribute('aria-label', `${r.n}. ${r.text.replace(/`/g, '')} (${r.word || (r.state === 'pass' ? 'passed' : 'to answer')})`)
        b.append(icon, body)
        li.append(b)
        // The selected question's answer box (media/checkAnswer.js).
        if (window.checkAnswer && V.answer && V.answer.id === r.id) li.append(window.checkAnswer.box(V.answer, r, post))
        ol.append(li)
      }
      app.append(ol)
    }
    if (focused) { const again = app.querySelector(`button.open[data-id="${focused}"]`); if (again) again.focus() }
    if (window.checkAnswer) window.checkAnswer.after(keep)
    report()
  }

  // ↑ ↓ Home End between the questions; Enter or Space opens one (a button).
  app.addEventListener('keydown', (e) => {
    const rows = [...app.querySelectorAll('button.open')]
    const i = rows.indexOf(document.activeElement)
    if (i < 0) return
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : undefined
    if (to === undefined) return
    e.preventDefault()
    const row = rows[Math.max(0, Math.min(rows.length - 1, to))]
    row.focus()
    // The arrows select a question: its answer box shows under it (Enter, a click or Tab goes into it).
    post({ type: 'select', id: row.dataset.id })
  })

  // What a person would notice: anything wider than the view, or a cut line.
  function report() {
    requestAnimationFrame(() => {
      const overflow = []
      for (const e of app.querySelectorAll('.title, .line, .who, .notice, .setup, .mr, .failed, .text, .meta, .flag, .commits, .also, button.primary, .busy, .answer .box, .answer .grade p, .answer .next, .tour')) {
        const r = e.getBoundingClientRect()
        if (r.right > document.documentElement.clientWidth + 1) overflow.push(`${e.className || e.tagName}: ${e.textContent.slice(0, 30)}`)
      }
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) overflow.push('the page scrolls sideways')
      post({ type: 'rendered', rows: V ? V.rows.length : 0, overflow, height: document.documentElement.scrollHeight })
    })
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (m.type === 'check') { V = m.view; render() }
    else if (m.type === 'test' && m.click) { const t = document.querySelector(m.click); if (t) t.click() }
    else if (window.checkAnswer) window.checkAnswer.message(m, post)
  })
  post({ type: 'ready' })
})()
