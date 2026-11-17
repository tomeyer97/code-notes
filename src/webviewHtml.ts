import type * as vscode from 'vscode'

// The parts every webview page of the extension has: text escaped for HTML, a nonce for its scripts, and the page
// itself (a CSP that lets in the extension's own styles and fonts and only the scripts carrying the nonce).

export const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** 24 random letters and digits: the page's scripts carry it, the CSP lets in only those. */
export const nonce = () => Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')

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
