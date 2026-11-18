// Which open document holds a file's unsaved edits (src/check/unsaved.ts): Commit & push offers and saves an applied
// fix by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import type { TextDocument } from 'vscode'
import { unsavedIn } from '../src/check/unsaved'

const repo = path.resolve('/repo')
const doc = (scheme: string, f: string, isDirty: boolean) =>
  ({ uri: { scheme, fsPath: path.join(repo, f) }, isDirty } as unknown as TextDocument)

test('an unsaved fix is found although a git diff view of the same file was opened first', () => {
  const file = doc('file', 'api/limits.js', true)
  assert.equal(unsavedIn([doc('git', 'api/limits.js', false), file], repo, 'api/limits.js'), file)
})

test('only the file itself counts: a dirty view in another scheme, a saved file or another file is not an unsaved fix', () => {
  assert.equal(unsavedIn([doc('git', 'api/limits.js', true)], repo, 'api/limits.js'), undefined)
  assert.equal(unsavedIn([doc('file', 'api/limits.js', false)], repo, 'api/limits.js'), undefined)
  assert.equal(unsavedIn([doc('file', 'api/other.js', true)], repo, 'api/limits.js'), undefined)
})
