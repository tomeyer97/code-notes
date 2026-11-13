import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeFile } from '../src/paths'

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
