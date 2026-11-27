import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLinkKey, folderFileKey, parseCheckLinkKey, sessionFileKey, stepDraftKey } from '../src/platform/keys'

test('composite keys: the strings the places that build and look them up agree on', () => {
  const folder = { toString: () => 'file:///w' }
  assert.equal(folderFileKey(folder, 'src/a.ts'), 'file:///w|src/a.ts')
  assert.equal(folderFileKey('file:///w', 'src/a.ts'), folderFileKey(folder, 'src/a.ts'), 'a URI or its string')
  assert.equal(sessionFileKey(undefined, folder, 'a.ts'), '|file:///w|a.ts')
  assert.equal(sessionFileKey('Review', folder, 'a.ts'), 'Review|file:///w|a.ts')
  assert.equal(stepDraftKey('shop', 's3'), 'shop|s3')
})

test('check link keys round-trip; other keys are not one', () => {
  assert.equal(checkLinkKey('20260101-x', 2), 'check|20260101-x|2')
  assert.deepEqual(parseCheckLinkKey(checkLinkKey('20260101-x', 2)), { noteId: '20260101-x', index: 2 })
  assert.equal(parseCheckLinkKey('file:///w|a.ts'), undefined)
  assert.equal(parseCheckLinkKey('check|a|b'), undefined)
})
