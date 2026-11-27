// Which open document holds a file's unsaved edits (src/check/unsaved.ts): Commit & push offers and saves an applied
// fix by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import { unsavedIn, type OpenDocument } from '../src/check/unsaved'

const repo = path.resolve('/repo')
const doc = (scheme: string, f: string, isDirty: boolean): OpenDocument => ({ uri: { scheme, fsPath: path.join(repo, f) }, isDirty })

test('an unsaved fix is found although a git diff view of the same file was opened first', () => {
  const file = doc('file', 'api/limits.js', true)
  assert.equal(unsavedIn([doc('git', 'api/limits.js', false), file], repo, 'api/limits.js'), file)
})

test('a dirty view of the same path in another scheme is not the unsaved fix', () => {
  assert.equal(unsavedIn([doc('git', 'api/limits.js', true)], repo, 'api/limits.js'), undefined)
})

test('a saved file is not an unsaved fix', () => {
  assert.equal(unsavedIn([doc('file', 'api/limits.js', false)], repo, 'api/limits.js'), undefined)
})

test('another file with unsaved edits is not the fix', () => {
  assert.equal(unsavedIn([doc('file', 'api/other.js', true)], repo, 'api/limits.js'), undefined)
})
