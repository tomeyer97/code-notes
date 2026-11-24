// The webview pages' HTML (src/webview/*.html) next to the compiled page.ts that reads them (out/src/webview/).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const from = path.join(root, 'src/webview')
const to = path.join(root, 'out/src/webview')
fs.mkdirSync(to, { recursive: true })
for (const n of fs.readdirSync(from)) if (n.endsWith('.html')) fs.copyFileSync(path.join(from, n), path.join(to, n))
