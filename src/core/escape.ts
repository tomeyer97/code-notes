// Text put into something that would read it as markup: one place for each kind, so there is one answer to "which
// escaper here". HTML for webview pages; Markdown for VS Code's renderer (tags, or every special character); labels
// VS Code escapes and then shows as text.

/** Text as HTML (for text and attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** A code span or a fenced block: left as it is by escapeTags (the split keeps them, at odd indexes). */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/

/**
 * Markdown for VS Code's renderer (no HTML allowed): `<name>`, `<id>` outside code is text, not a tag that the sanitizer
 * swallows. Code spans and fenced blocks are left as they are; `<` and `>` elsewhere get a backslash.
 */
export function escapeTags(md: string): string {
  const escape = (text: string) => text.replace(/\\?([<>])/g, '\\$1')
  return md.split(CODE).map((part, i) => (i % 2 ? part : escape(part))).join('')
}

/** Plain text in Markdown: every character Markdown would read (\ ` * _ [ ] < >) gets a backslash. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, '\\$&')
}

/**
 * Text for a comment thread's label: VS Code HTML-escapes a label and then shows it as text ("&lt;script&gt;"), so
 * <, > and & are drawn with look-alikes (‹ › ＆) instead.
 */
export function labelSafe(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆')
}
