import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

// From a remote extension host every vscode.workspace.fs call is a round trip through the window: the extension's
// files go through wfs.ts (Node's fs for file: URIs) instead.
const SRC = path.join(__dirname, '../../src')

test('no vscode.workspace.fs outside wfs.ts (src/ and its folders)', () => {
  const sources = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && f !== 'wfs.ts')
  const lines = sources.flatMap((f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const))
  const hits = lines.filter(([, , l]) => /workspace\.fs\b/.test(l)).map(([f, i]) => `${f}:${i}`)
  assert.deepEqual(hits, [])
})

test('no vscode.workspace.openTextDocument just to read lines in the step paths (code links, value hints)', () => {
  for (const f of ['codeLinks.ts', 'valueHints.ts']) assert.ok(!/openTextDocument/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f)
})
