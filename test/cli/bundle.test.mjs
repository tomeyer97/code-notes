// cli/understanding.mjs is committed (CI recipes download it by URL): it must be the build of cli/understanding/*.ts
// as they are (npm run build writes it; the build checks the types first).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { BUILT, buildCli } from '../../scripts/build/cli.mjs'

const SOURCES = path.join(path.dirname(BUILT), 'understanding')

test('cli/understanding.mjs is up to date (npm run build)', async () => {
  assert.equal(fs.readFileSync(BUILT, 'utf8'), (await buildCli()).text)
})

test('every module of cli/understanding/ is in the built file (types.ts: types only)', async () => {
  const { inputs } = await buildCli()
  const modules = fs.readdirSync(SOURCES).filter((f) => f.endsWith('.ts') && f !== 'types.ts').map((f) => `cli/understanding/${f}`)
  assert.deepEqual(modules.filter((m) => !inputs.includes(m)), [])
})
