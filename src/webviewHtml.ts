// The page of a webview: its Content Security Policy (styles from the extension, scripts only with this page's nonce),
// its stylesheets and scripts from media/. No other HTML is written here.
import * as vscode from 'vscode'

/** A fresh nonce for a webview's scripts (24 letters and digits). */
export function nonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

/** A webview page with `css` and `js` from media/ (in that order) and an empty `<div id="app">`. */
export function webviewHtml(w: vscode.Webview, extUri: vscode.Uri, o: { css: string[]; js: string[] }): string {
  const n = nonce()
  const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f))
  const csp = `default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${n}';`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...o.css.map((f) => `<link rel="stylesheet" href="${uri(f)}">`),
    '</head>',
    '<body><div id="app"></div>',
    ...o.js.map((f) => `<script nonce="${n}" src="${uri(f)}"></script>`),
    '</body></html>',
  ].join('\n')
}
