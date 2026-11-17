import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

// From a remote extension host every vscode.workspace.fs call is a round trip through the window: the extension's
// files go through wfs.ts (Node's fs for file: URIs) instead.
test('no vscode.workspace.fs outside wfs.ts', () => {
  const dir = path.join(__dirname, '../../src')
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'wfs.ts')
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const))
    .filter(([, , l]) => /workspace\.fs\b/.test(l)).map(([f, i]) => `${f}:${i}`)
  assert.deepEqual(hits, [])
})

test('no vscode.workspace.openTextDocument just to read lines in the step paths', () => {
  const dir = path.join(__dirname, '../../src')
  for (const f of ['codeLinks.ts', 'valueHints.ts']) assert.ok(!/openTextDocument/.test(fs.readFileSync(path.join(dir, f), 'utf8')), f)
})
