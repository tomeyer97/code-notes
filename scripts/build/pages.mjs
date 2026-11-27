// The webview pages: each page's script is one bundle, out/pages/<page>.js, built by esbuild from media/ (ES modules
// that import each other and the message types of src/protocol/), after a type check (media/tsconfig.json). The
// extension (src/webview/page.ts pageScript) and the harness pages under test/ load the same files. Also the pages'
// HTML (src/webview/*.html) next to the compiled page.ts that reads them (out/src/webview/), and the scene player's
// script (test/journey-scene/player.html, for videos).
// `--watch`: builds once, then again on every change (npm run watch); no type check then.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Each page and its entry module (src/webview/page.ts PageName). */
const PAGES = {
  map: 'media/journey-map.js',
  listen: 'media/listen.js',
  check: 'media/check.js',
  clarify: 'media/clarify.js',
}
/** Test pages built the same way: out/<path>.js. */
const TEST_PAGES = { 'test/journey-scene/player': 'test/journey-scene/player.js' }

/** esbuild's options for the page bundles: classic scripts (a webview's nonce'd <script>), one file per page. */
const OPTIONS = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  logLevel: 'warning',
}

/** Type-checks the pages' scripts (media/tsconfig.json); exits on an error. */
function typeCheck() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'media/tsconfig.json')], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function copyHtml() {
  const from = path.join(root, 'src/webview')
  const to = path.join(root, 'out/src/webview')
  fs.mkdirSync(to, { recursive: true })
  for (const n of fs.readdirSync(from)) if (n.endsWith('.html')) fs.copyFileSync(path.join(from, n), path.join(to, n))
}

const entryPoints = [
  ...Object.entries(PAGES).map(([out, from]) => ({ in: path.join(root, from), out: `pages/${out}` })),
  ...Object.entries(TEST_PAGES).map(([out, from]) => ({ in: path.join(root, from), out })),
]

copyHtml()
if (process.argv.includes('--watch')) {
  // Source maps while developing (the packaged pages go without them).
  const ctx = await esbuild.context({ ...OPTIONS, sourcemap: 'linked', entryPoints, outdir: path.join(root, 'out') })
  await ctx.watch()
  console.log('out/pages: watching media/')
} else {
  typeCheck()
  await esbuild.build({ ...OPTIONS, entryPoints, outdir: path.join(root, 'out') })
}
