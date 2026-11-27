// The Check view (a webview in the Code Notes sidebar): the page's script, bundled as out/pages/check.js. Plain DOM,
// textContent only. The answer box under the selected question is checkAnswer.js; how a question's state looks is
// src/protocol/check.ts QSTATE (the journey panel's storyline draws them too). Its messages both ways are
// src/protocol/check.ts (ToCheck, FromCheck). Its classes are scoped under #app.check (check.css).
import { el, button, joinDots, baseName, connect, onMessages, rovingKeys } from './common.js'
import { watched, WATCHED, overflowing } from './report.js'
import { codeSpans, plainText } from './codeSpans.js'
import { runTestMessage } from './map/testHooks.js'
import { QSTATE } from '../src/protocol/check'
import { answerBoxes } from './checkAnswer.js'

/** @typedef {import('../src/protocol/check').ToCheck} ToCheck */
/** @typedef {import('../src/protocol/check').FromCheck} FromCheck */
/** @typedef {import('../src/check/checkViewTypes').CheckView} CheckView */
/** @typedef {import('../src/check/checkViewTypes').CheckRow} CheckRow */

const { post } = /** @type {import('./types').Port<FromCheck>} */ (connect())
const app = /** @type {HTMLElement} */ (document.getElementById('app'))
/** The answer box: drawn under the selected row; keeps the keyboard across a render. */
const answers = answerBoxes(post)

/** Draws `view` (src/check/viewModel.ts checkView; null: no repository) again, the keyboard kept where it was (on a
 *  row, or in the answer box). */
/** @param {CheckView | null} view */
function render(view) {
  const row = focusedRow()
  const box = answers.saveFocus()
  app.textContent = ''
  if (view) draw(view)
  else app.append(el('p', 'muted', 'Open a git repository to check your understanding of a change.'))
  if (row) focusRow(row)
  answers.restoreFocus(box)
  report(view)
}

/** Where the check stands, the button, the tour, the questions. */
function draw(view) {
  app.append(header(view))
  if (view.busy) app.append(watched(el('p', 'busy', view.busy)))
  // The one button right under where the check stands (never below the questions, out of sight).
  if (view.action) app.append(footer(view))
  if (view.tour) app.append(tourLink(view.tour))
  if (view.rows.length) {
    const ol = el('ol', 'rows')
    ol.setAttribute('aria-label', 'Questions')
    for (const r of view.rows) ol.append(row(r, view.answer))
    app.append(ol)
  }
}

/** The question whose row has the keyboard (its id), if one has. */
function focusedRow() {
  const active = /** @type {HTMLElement | null} */ (document.activeElement)
  return active && active.dataset ? active.dataset.id : undefined
}
/** The keyboard back on question `id`'s row. */
function focusRow(id) {
  const again = /** @type {HTMLElement | null} */ (app.querySelector(`button.open[data-id="${CSS.escape(id)}"]`))
  if (again) again.focus()
}

/** The tour of the change: one quiet link (walking it is optional; the rows go straight to a question), or one
 *  muted line while it is written. */
function tourLink(tour) {
  if (!tour.action) return watched(el('p', 'busy tour', tour.label))
  const type = tour.action === 'walk' ? 'tour' : 'writeTour'
  return watched(button('link tour', tour.label, () => post({ type })))
}

/** Where the check stands: its title, the rule, who, a notice; a failure; what setup said; a merge request's link. */
function header(view) {
  const h = el('header', `tone-${view.tone}`)
  h.append(watched(el('p', 'title', view.title)))
  if (view.line) h.append(watched(el('p', 'line', view.line)))
  if (view.who) h.append(watched(el('p', 'who', view.who)))
  if (view.notice) h.append(watched(el('p', 'notice', view.notice)))
  if (view.failed) h.append(failure(view.failed))
  if (view.said) h.append(watched(el('p', 'setup said', view.said)))
  // Pushed a branch without a merge request: the link the push printed.
  if (view.mr) {
    const p = watched(el('p', 'mr'))
    const b = button('link', 'Open merge request ↗', () => post({ type: 'openMr' }))
    b.title = view.mr
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

/** The one button (it sends its action's id: src/check/checkWords.ts ACTIONS). Commit & push: what it commits, and a
 *  file to tick (a TODO the check added). A conflict: beside Keep both answers, the file itself. */
function footer(view) {
  const f = el('footer')
  if (view.commits) f.append(watched(el('p', 'commits', view.commits)))
  for (const a of view.also || []) f.append(alsoTick(a))
  const action = view.action
  f.append(watched(button('primary', action.label, () => post({ type: action.id }))))
  if (action.id === 'merge') f.append(' ', button('link open-file', 'Open the file', () => post({ type: 'openFile' })))
  return f
}
/** A file offered with Commit & push, ticked or not. */
function alsoTick(a) {
  const l = watched(el('label', 'also'))
  const c = el('input')
  c.type = 'checkbox'
  c.checked = a.on
  c.dataset.file = a.file
  c.onchange = () => post({ type: 'include', file: a.file, on: c.checked })
  l.append(c, el('span', '', a.label))
  return l
}

/** File names only: lines are what a click shows. */
const fileName = (where) => baseName(where).replace(/:\d+(-\d+)?$/, '')

/** A question row's tooltip: the whole question, its kind, its step, where; the other places. */
function tooltip(r) {
  const step = r.step ? ` · after step ${r.step} of the tour` : ''
  const also = r.also.length ? `\nAlso: ${r.also.join(', ')}` : ''
  return `${r.text}\n${r.kind}${step} · ${r.where}${also}`
}
/** Its meta line: kind · step · files · state word. */
function metaLine(r) {
  const files = [fileName(r.where), ...r.also.map((a) => `+ ${fileName(a)}`)]
  return [r.kind, r.step ? `step ${r.step}` : '', ...files, r.word].filter(Boolean).join(' · ')
}
/** What a screen reader says for it. */
function spoken(r) {
  const said = r.word || (r.state === 'pass' ? 'passed' : 'to answer')
  return `${r.n}. ${plainText(r.text)} (${said})`
}
/** A state's icon in the list (an unknown one: not answered yet). */
const stateIcon = (state) => (Object.hasOwn(QSTATE, state) && QSTATE[state].icon) || QSTATE.todo.icon

/** A question: its state's icon, its text (`name` shown as code), the meta line, a flag; the answer box under the
 *  selected one (media/checkAnswer.js). */
function row(r, answer) {
  const li = el('li', `row ${r.state}`)
  const b = button('open', undefined, () => post({ type: 'open', id: r.id }))
  b.title = tooltip(r)
  b.dataset.id = r.id
  b.setAttribute('aria-label', spoken(r))
  const icon = el('span', 'icon', stateIcon(r.state))
  icon.setAttribute('aria-hidden', 'true')
  const body = el('span', 'body')
  const text = watched(el('span', 'text'))
  text.append(...codeSpans(r.text))
  body.append(text, watched(el('span', 'meta', metaLine(r))))
  if (r.flag) body.append(watched(el('span', 'flag', `⚠ ${r.flag}`)))
  b.append(icon, body)
  li.append(b)
  if (answer && answer.id === r.id) li.append(answers.box(answer, r))
  return li
}

// ↑ ↓ Home End between the questions; Enter or Space opens one (a button).
app.addEventListener('keydown', (e) => {
  const rows = /** @type {HTMLElement[]} */ ([...app.querySelectorAll('button.open')])
  const i = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement))
  if (i < 0) return
  // The arrows select a question: its answer box shows under it (Enter, a click or Tab goes into it).
  const selectRow = (r) => {
    r.focus()
    post({ type: 'select', id: r.dataset.id })
  }
  rovingKeys(e, rows, i, { prev: 'ArrowUp', next: 'ArrowDown' }, selectRow)
})

// What a person would notice: anything wider than the view, or a cut line (in the elements made watched()).
function report(view) {
  requestAnimationFrame(() => {
    const overflow = overflowing(app, WATCHED, (e) => `${e.className || e.tagName}: ${e.textContent.slice(0, 30)}`)
    post({ type: 'rendered', rows: view ? view.rows.length : 0, overflow, height: document.documentElement.scrollHeight })
  })
}

/** @type {import('./types').Handlers<ToCheck>} */
const handlers = {
  check(m) { render(m.view) },
  focus(m) { answers.focus(m.id) },
  test: runTestMessage,
}
// A message of a type this page doesn't know: said in the extension's log (a typo would otherwise go unnoticed).
onMessages(handlers, (m) => post({ type: 'error', message: `check view: no handler for "${m.type}"` }))
post({ type: 'ready' })
