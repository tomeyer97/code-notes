// cli/understanding.mjs is built from cli/understanding/*.mjs (cli/bundle.mjs): the committed file must be the build
// of the modules as they are, and every module must load on its own (its imports name what it uses).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUILT, ORDER, SOURCES, bundle } from '../../cli/bundle.mjs'

test('cli/understanding.mjs is the build of cli/understanding/ (run npm run cli)', () => {
  assert.equal(fs.readFileSync(BUILT, 'utf8'), bundle())
})

test('cli/bundle.mjs joins every module of cli/understanding/', () => {
  assert.deepEqual(fs.readdirSync(SOURCES).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort(), [...ORDER].sort())
})

test('each module of cli/understanding/ loads on its own', async () => {
  for (const name of ORDER) await import(pathToFileURL(path.join(SOURCES, `${name}.mjs`)).href)
})
