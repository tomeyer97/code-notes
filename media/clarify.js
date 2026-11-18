// "Claude asks" (src/write/clarify.ts): Claude's question before it writes a journey, and a box for your answer.
// The answer's draft is kept in the webview's state. Out (src/write/clarify.ts handles them):
//   { type: 'reply', text }   Send or Ctrl+Enter, with something typed
//   { type: 'error', text }   a script error on the page
;(function () {
  const vscode = acquireVsCodeApi()
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', text: String(e.message) }))
  const answer = document.getElementById('answer')
  const saved = vscode.getState()
  if (saved && saved.text) answer.value = saved.text
  answer.addEventListener('input', () => vscode.setState({ text: answer.value }))
  const send = () => {
    const text = answer.value.trim()
    if (text) vscode.postMessage({ type: 'reply', text })
  }
  document.getElementById('send').addEventListener('click', send)
  answer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  })
  answer.focus()
})()
