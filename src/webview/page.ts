// Webview pages: a nonce for their scripts, HTML escaping, and pages kept as .html files next to this one (copied to
// out/ by the build), filled in where they say {{name}}.

import * as fs from 'fs'
import * as path from 'path'

/** A fresh nonce for a page's <script> tags (its Content-Security-Policy allows only those). */
export function nonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

/** Text as HTML (for text and attribute values; markdown is escaped with escapeTags in journeyModel.ts). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** The page `name`.html with each {{key}} replaced by its value (as given: escape text first). */
export function page(name: string, values: Record<string, string>): string {
  const html = fs.readFileSync(path.join(__dirname, `${name}.html`), 'utf8')
  return html.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m)
}
