// npm run build: compiles the extension and its tests (tsc -p .), then runs every scripts/build/*.mjs in name order,
// each one build target (the CLI bundle, the vendored libraries, the webview pages).
// npm run watch (the F5 task in .vscode/tasks.json): the same targets once, then the pages (scripts/build/pages.mjs
// --watch) and tsc in watch mode.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const watch = process.argv.includes('--watch')

/** Runs `node <args>` in the repository root; exits with its status when it fails. */
function node(...args) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!watch) node(tsc, '-p', '.')
const dir = path.join(root, 'scripts', 'build')
for (const step of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) node(path.join(dir, step))
if (watch) {
  spawn(process.execPath, [path.join(dir, 'pages.mjs'), '--watch'], { cwd: root, stdio: 'inherit' })
  node(tsc, '-w', '-p', '.')
}
