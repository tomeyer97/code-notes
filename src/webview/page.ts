// Webview pages, in one place: text escaped for HTML, a nonce for their scripts, the page around a view's own files
// (webviewPage: a CSP that lets in the extension's styles and fonts and only the scripts carrying the nonce), and
// pages kept as .html files next to this one (copied to out/ by `npm run pages`), filled in where they say {{name}}.
// cli/understanding.mjs builds no webview, so it needs none of this.

import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'

/** Text as HTML (for text and attribute values; markdown is escaped with escapeTags in journeys/textFormat.ts). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** 24 random letters and digits: the page's scripts carry it, its Content-Security-Policy lets in only those. */
export function nonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

/** A page: the stylesheets, `body`, then `inline` (a script's text, run first) and the scripts, in this order. */
export function webviewPage(w: vscode.Webview, o: { css: vscode.Uri[]; body: string; inline?: string; scripts: vscode.Uri[] }): string {
  const n = nonce()
  const scripts = [
    ...(o.inline ? [`<script nonce="${n}">${o.inline}</script>`] : []),
    ...o.scripts.map((u) => `<script nonce="${n}" src="${w.asWebviewUri(u)}"></script>`),
  ]
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.css.map((u) => `<link rel="stylesheet" href="${w.asWebviewUri(u)}">`).join('\n')}
</head><body>${o.body}
${scripts.join('\n')}</body></html>`
}

/** The page `name`.html with each {{key}} replaced by its value (as given: escape text first). */
export function page(name: string, values: Record<string, string>): string {
  const html = fs.readFileSync(path.join(__dirname, `${name}.html`), 'utf8')
  return html.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m)
}
