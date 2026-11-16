// The Check view (a webview in the Code Notes sidebar). Plain DOM, textContent only.
// In:  { type: 'check', view } (src/checkModel.ts CheckView, or null)   { type: 'test', click: selector }
// Out: { type: 'ready' } { type: 'open', id } { type: 'start' | 'topUp' | 'scm' | 'commitPush' } { type: 'include', file, on }
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
    app.textContent = ''
    if (!V) { app.append(el('p', 'muted', 'Open a git repository to check your understanding of a change.')); report(); return }
    const h = el('header', `tone-${V.tone}`)
    h.append(el('p', 'title', V.title))
    if (V.line) h.append(el('p', 'line', V.line))
    if (V.who) h.append(el('p', 'who', V.who))
    if (V.notice) h.append(el('p', 'notice', V.notice))
    app.append(h)
    if (V.busy) app.append(el('p', 'busy', V.busy))
    if (V.rows.length) {
      const ol = el('ol', 'rows')
      ol.setAttribute('aria-label', 'Questions')
      for (const r of V.rows) {
        const li = el('li', `row ${r.state}`)
        const b = el('button', 'open')
        b.title = `${r.text}\n${r.kind} · ${r.where}${r.also.length ? `\nAlso: ${r.also.join(', ')}` : ''}`
        b.dataset.id = r.id
        b.onclick = () => post({ type: 'open', id: r.id })
        const icon = el('span', 'icon', ICON[r.state] || '○')
        icon.setAttribute('aria-hidden', 'true')
        const body = el('span', 'body')
        // File names only: lines are what a click shows.
        const name = (w) => w.split('/').pop().replace(/:\d+(-\d+)?$/, '')
        const meta = [r.kind, name(r.where), ...r.also.map((a) => `+ ${name(a)}`), r.word].filter(Boolean).join(' · ')
        body.append(el('span', 'text', r.text), el('span', 'meta', meta))
        if (r.flag) body.append(el('span', 'flag', `⚠ ${r.flag}`))
        b.setAttribute('aria-label', `${r.n}. ${r.text} (${r.word || (r.state === 'pass' ? 'passed' : 'to answer')})`)
        b.append(icon, body)
        li.append(b)
        ol.append(li)
      }
      app.append(ol)
    }
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
      const b = el('button', 'primary', V.action.label); b.onclick = () => post({ type: V.action.id }); f.append(b); app.append(f)
    }
    if (focused) { const again = app.querySelector(`button.open[data-id="${focused}"]`); if (again) again.focus() }
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
    rows[Math.max(0, Math.min(rows.length - 1, to))].focus()
  })

  // What a person would notice: anything wider than the view, or a cut line.
  function report() {
    requestAnimationFrame(() => {
      const overflow = []
      for (const e of app.querySelectorAll('.title, .line, .who, .notice, .text, .meta, .flag, .commits, .also, button.primary, .busy')) {
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
  })
  post({ type: 'ready' })
})()
