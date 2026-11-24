import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { gitOut, HISTORY_GIT, QUICK_GIT, statusBranch, statusPaths } from '../src/platform/git'

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

test('git runs in the repo; a failure is undefined; an empty output is undefined unless allowed', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-git-'))
  try {
    assert.equal(await gitOut(repo, ['init', '-q']), undefined, 'no output')
    assert.equal(await gitOut(repo, ['status', '--porcelain'], true), '')
    assert.equal(await gitOut(repo, ['rev-parse', '--is-inside-work-tree'], false, QUICK_GIT), 'true')
    assert.equal(await gitOut(repo, ['config', '--get', 'core.bare'], false, HISTORY_GIT), 'false')
    assert.equal(await gitOut(path.join(repo, 'nope'), ['status']), undefined, 'no folder: undefined, no error')
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})
