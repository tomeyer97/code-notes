import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeFile, settingFolder } from '../src/core/paths'

const root = '/home/dev/shop'

test('relative paths are normalised', () => {
  assert.equal(placeFile(root, 'src/a.ts'), 'src/a.ts')
  assert.equal(placeFile(root, './src/a.ts'), 'src/a.ts')
  assert.equal(placeFile(root, 'src\\a.ts'), 'src/a.ts')
  assert.equal(placeFile(root, 'src/x/../a.ts'), 'src/a.ts')
})

test('an absolute path inside the workspace becomes relative', () => {
  assert.equal(placeFile(root, '/home/dev/shop/src/session.ts'), 'src/session.ts')
})

test('paths outside the workspace are refused', () => {
  for (const f of ['../../../etc/passwd', '/etc/passwd', 'src/../../x', '..', '/home/dev/shop2/a.ts']) {
    assert.equal(typeof placeFile(root, f), 'object', f)
  }
})

test('settingFolder: a folder setting as a slash path from the workspace folder', () => {
  for (const v of ['notes', 'notes/', 'notes\\', './notes', '.\\notes', '././notes/']) assert.equal(settingFolder(v), 'notes', v)
  assert.equal(settingFolder('review\\notes'), 'review/notes')
  assert.equal(settingFolder('.code-notes'), '.code-notes')
})
