// "Claude asks" (src/write/clarify.ts): Claude's question before it writes a journey, and a box for your answer; the
// page's script, bundled as out/pages/clarify.js. The answer's draft is kept in the webview's state. What it posts is
// src/protocol/clarify.ts FromClarify (its errors: common.js connect(), as on every page).
import { connect } from './common.js'

/** @typedef {import('../src/protocol/clarify').FromClarify} FromClarify */

const { vscode, post } = /** @type {import('./types').Port<FromClarify>} */ (connect())
const answer = /** @type {HTMLTextAreaElement} */ (document.getElementById('answer'))
const saved = vscode.getState()
if (saved && saved.text) answer.value = saved.text
answer.addEventListener('input', () => vscode.setState({ text: answer.value }))
const send = () => {
  const text = answer.value.trim()
  if (text) post({ type: 'reply', text })
}
document.getElementById('send')?.addEventListener('click', send)
answer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    send()
  }
})
answer.focus()
