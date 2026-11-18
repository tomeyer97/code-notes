import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusBranch, statusPaths } from '../src/git'

test('git status v2 entries: their paths (renames: the new one), the branch', () => {
  const out = [
    '# branch.oid 0123',
    '# branch.head feat/x',
    '1 .M N... 100644 100644 100644 aaa aaa src/a b.ts',
    '2 R. N... 100644 100644 100644 bbb bbb R100 new.ts',
    'old.ts',
    'u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.ts',
    '? scratch.js',
    '',
  ].join('\0')
  assert.deepEqual(statusPaths(out), ['src/a b.ts', 'new.ts', 'conflict.ts', 'scratch.js'])
  assert.equal(statusBranch(out), 'feat/x')
  assert.equal(statusBranch(''), undefined)
})

test('git status v2: ignored entries count, headers and an empty output give nothing', () => {
  assert.deepEqual(statusPaths(['# branch.oid (initial)', '# branch.head main', '! build/out.js', ''].join('\0')), ['build/out.js'])
  assert.deepEqual(statusPaths(''), [])
})

test('a detached HEAD is named as git names it', () => {
  assert.equal(statusBranch(['# branch.oid 0123', '# branch.head (detached)', ''].join('\0')), '(detached)')
})
