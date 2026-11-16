// The understanding check's panel (a webview). Plain DOM.
// In:  { type: 'check', view } (src/checkModel.ts CheckView)   { type: 'test', click: selector }
// Out: { type: 'ready' } { type: 'open', id } { type: 'stage' } { type: 'topUp' }
//      { type: 'rendered', rows, overflow } (what is cut or sticks out, for tests) { type: 'error', message }
;(function () {
  const vscode = acquireVsCodeApi()
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) }))
  const app = document.getElementById('app')
  const ICON = { todo: '○', ungraded: '…', pass: '✓', retry: '↻', explained: '·' }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const post = (m) => vscode.postMessage(m)
  let V

  function render() {
    app.textContent = ''
    if (!V) return
    const h = el('header')
    h.append(el('h1', '', 'Check my understanding'), el('p', `progress${V.met ? ' met' : ''}`, V.progress || V.branch))
    app.append(h)
    if (V.busy) app.append(el('p', 'busy', V.busy))
    const ol = el('ol', 'rows')
    for (const r of V.rows) {
      const li = el('li', `row ${r.state}`)
      const b = el('button', 'open')
      b.title = `${r.text}\n${r.kind} · ${r.where}`
      b.dataset.id = r.id
      b.onclick = () => post({ type: 'open', id: r.id })
      const icon = el('span', 'icon', ICON[r.state] || '○')
      icon.setAttribute('aria-label', r.word)
      const body = el('span', 'body')
      body.append(el('span', 'text', r.text), el('span', 'meta', `${r.kind} · ${r.where.split('/').pop()}${r.state === 'todo' || r.state === 'pass' ? '' : ` · ${r.word}`}`))
      b.append(icon, body)
      li.append(b)
      ol.append(li)
    }
    app.append(ol)
    if (V.next) {
      const f = el('footer', V.met ? 'met' : '')
      f.append(el('p', '', V.next.text))
      if (V.next.action) { const b = el('button', 'primary', V.next.button); b.onclick = () => post({ type: V.next.action }); f.append(b) }
      app.append(f)
    }
    // What a person would notice: anything wider than the panel, or a cut line.
    requestAnimationFrame(() => {
      const overflow = []
      for (const e of app.querySelectorAll('h1, .progress, .text, .meta, footer p, button.primary, .busy')) {
        const r = e.getBoundingClientRect()
        if (r.right > document.documentElement.clientWidth + 1) overflow.push(`${e.className || e.tagName}: ${e.textContent.slice(0, 30)}`)
      }
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) overflow.push('the page scrolls sideways')
      post({ type: 'rendered', rows: V.rows.length, overflow })
    })
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (m.type === 'check') { V = m.view; render() }
    else if (m.type === 'test' && m.click) { const t = document.querySelector(m.click); if (t) t.click() }
  })
  post({ type: 'ready' })
})()
