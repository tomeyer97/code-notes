// The understanding CLI's functions the extension calls (src/check/cliApi.ts, cliWorker.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { hostCli } from '../src/check/cliApi'
import { workerApi } from '../src/check/cliWorker'

test('every CLI function the extension calls is one the built CLI exports', () => {
  // The extension compiles the CLI's modules; people run cli/understanding.mjs, built from the same modules: the names
  // it calls are the CLI's public API.
  const built = path.join(__dirname, '../../cli/understanding.mjs')
  const list = `import(${JSON.stringify(pathToFileURL(built).href)}).then((m) => console.log(JSON.stringify(Object.keys(m))))`
  const exported = new Set<string>(JSON.parse(execFileSync(process.execPath, ['-e', list], { encoding: 'utf8' })))
  const called = [...Object.keys(hostCli), ...Object.keys(workerApi).filter((n) => n !== 'refreshState'), 'refreshInputs', 'localStatus', 'gitIdentity']
  assert.ok(called.length > 25, `found ${called.length} names`)
  assert.deepEqual(called.filter((n) => !exported.has(n)), [])
})
