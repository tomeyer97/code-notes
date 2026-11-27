// "Changed since commit X" (src/platform/gitChanged.ts) and the podcast's use of it (src/podcast/changedSince.ts):
// the steps whose file changed since the commit a podcast was recorded for, and a word in the output when git can't say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { changedFiles, isCommitId } from '../src/platform/gitChanged'
import { ChangedSince, stepsTouching } from '../src/podcast/changedSince'
import type { Journey } from '../src/core/format/journeyModel'

/** A scratch repository with a.ts and b.ts committed; `commit` is that commit. */
function scratch(): { repo: string; commit: string; done: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-changed-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n')
  fs.writeFileSync(path.join(repo, 'b.ts'), 'b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  return { repo, commit: git('rev-parse', 'HEAD'), done: () => fs.rmSync(repo, { recursive: true, force: true }) }
}

/** A journey on a.ts, b.ts and c.ts, in `repo`. */
const journeyIn = (repo: string) => ({
  key: 'j', folder: { uri: { scheme: 'file', fsPath: repo } },
  j: { id: 'j', steps: [{ id: 's1', file: 'a.ts' }, { id: 's2', file: 'b.ts' }, { id: 's3', file: 'c.ts' }] } as unknown as Journey,
  at: [],
}) as unknown as Parameters<ChangedSince['steps']>[0]

test('changed files: committed since or edited since; nothing changed is an empty set; a bad commit is said', async () => {
  const { repo, commit, done } = scratch()
  try {
    assert.deepEqual(await changedFiles(repo, commit), { files: new Set() })
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b2\n')
    assert.deepEqual(await changedFiles(repo, commit), { files: new Set(['b.ts']) })
    assert.match((await changedFiles(repo, 'not-a-commit') as { why: string }).why, /not a commit id/)
    assert.match((await changedFiles(repo, 'abcdef12') as { why: string }).why, /git could not compare with abcdef12/)
    assert.ok(isCommitId(commit) && isCommitId('abcd') && !isCommitId('abc') && !isCommitId('--all'))
  } finally { done() }
})

test('changed since recording: the steps on a changed file, by number; when git can\'t say, said once', async () => {
  const { repo, commit, done } = scratch()
  try {
    const lines: string[] = []
    const changed = new ChangedSince((l) => lines.push(l))
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b2\n')
    assert.deepEqual(await changed.steps(journeyIn(repo), commit), [2])
    assert.equal(await changed.steps(journeyIn(repo), 'abcdef12'), undefined)
    assert.equal(await changed.steps(journeyIn(repo), 'abcdef12'), undefined)
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.match(lines[0], /^podcast of journey j: can't tell which steps changed since recording: git could not compare/)
  } finally { done() }
})

test('steps touching files: as the step is now, or as written', () => {
  const lj = { j: { steps: [{ file: 'a.ts' }, { file: 'old.ts' }, { file: 'c.ts' }] }, at: [undefined, { file: 'new.ts' }, undefined] } as unknown as Parameters<typeof stepsTouching>[0]
  assert.deepEqual(stepsTouching(lj, new Set(['new.ts', 'c.ts'])), [2, 3])
  assert.deepEqual(stepsTouching(lj, new Set(['old.ts'])), [2])
  assert.deepEqual(stepsTouching(lj, new Set()), [])
})
