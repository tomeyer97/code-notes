// The CLI's modules (cli/understanding/<name>.ts) for unit tests, built from the sources each time the tests run, so a
// test's result never depends on cli/understanding.mjs having been rebuilt (test/cli/bundle.test.mjs checks that).
// Each module is bundled alone with esbuild (the build's own bundler): its exports are the module's, not the CLI's
// entry, and module state is not shared between two modules loaded here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const SOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../cli/understanding')
const loaded = new Map()
let dir

/** The module cli/understanding/<name>.ts, as its exports. */
export function cliModule(name) {
  if (!loaded.has(name)) loaded.set(name, load(name))
  return loaded.get(name)
}

async function load(name) {
  const r = await esbuild.build({
    entryPoints: [path.join(SOURCES, `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', target: 'node18',
    write: false, logLevel: 'warning',
  })
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cli-module-'))
  const file = path.join(dir, `${name}.mjs`)
  fs.writeFileSync(file, r.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
