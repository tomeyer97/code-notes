// The little markdown a journey's text uses, as HTML: escaped first (the extension's own escaper,
// src/core/escape.ts), then marked up. Tested in test/journeyMapPage.test.ts.
import { escapeHtml as esc } from '../../src/core/escape'

/** Enough markdown for summaries: `code` and **bold** (one pass each: **bold** inside `code` is still bold). */
export function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
}

/** A line of step text: md, the links the step card's click handler posts back, and ~~gone~~. */
export function inline(t) {
  return md(t)
    // [text](ref:i): code the step points at
    .replace(/\[([^\]]+)\]\(ref:(\d+)\)/g, '<button class="ref link" data-i="$2">$1</button>')
    // [text](note:id): a question asked about the step
    .replace(/\[([^\]]+)\]\(note:([\w.-]+)\)/g, '<button class="noteq link" data-id="$2">$1</button>')
    // [text](ask:update): ask for the step's update
    .replace(/\[([^\]]+)\]\(ask:update\)/g, '<button class="askupd link">$1</button>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
}

/** A fenced block's lines; a diff's (a stale step's) coloured: - deleted, + inserted. */
function fence(lang, body) {
  const cls = (l) => (lang === 'diff' && /^[-+]/.test(l) ? (l[0] === '-' ? 'del' : 'ins') : '')
  return `<pre class="code">${body.split('\n').map((l) => `<span class="${cls(l)}">${esc(l)}</span>`).join('\n')}</pre>`
}

/** A placeholder line for fenced block `i`, which the paragraph split leaves alone. */
const FENCE_MARK = /^\u0000(\d+)\u0000$/

/** Step text: inline markup, fenced blocks, paragraphs, "- " lists, ---. */
export function mdBlock(s) {
  const fences = []
  s = s.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_m, lang, body) => {
    fences.push(fence(lang, body))
    return `\u0000${fences.length - 1}\u0000`
  })
  return s.split(/\n{2,}/).map((p) => {
    const f = FENCE_MARK.exec(p.trim())
    if (f) return fences[Number(f[1])]
    if (/^\s*---\s*$/.test(p)) return '<hr>'
    const lines = p.split('\n')
    if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
    return `<p>${lines.map(inline).join('<br>')}</p>`
  }).join('')
}
