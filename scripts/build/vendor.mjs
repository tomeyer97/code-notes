// The libraries the webview pages load from out/vendor/: ELK (the map's layout) and its licence.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, 'out/vendor')
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(path.join(root, 'node_modules/elkjs/lib/elk.bundled.js'), path.join(out, 'elk.bundled.js'))
fs.copyFileSync(path.join(root, 'node_modules/elkjs/LICENSE.md'), path.join(out, 'elk-LICENSE.md'))
