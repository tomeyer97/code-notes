import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { gitRenames } from '../src/gitRenames'

/** A repository with a.go committed, then renamed to b.go in a second commit; returns it and the first commit. */
function repoWithRename(): { repo: string; git: (...a: string[]) => Buffer; base: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-git-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.go'), Array.from({ length: 40 }, (_, i) => `line ${i} of a`).join('\n'))
  git('add', '.'); git('commit', '-qm', 'one')
  const base = git('rev-parse', '--short', 'HEAD').toString().trim()
  git('mv', 'a.go', 'b.go'); git('commit', '-qm', 'two')
  return { repo, git, base }
}

test('renames come from git, as journey.py check finds them', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-git-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  git('init', '-q')
  fs.mkdirSync(path.join(repo, 'web/cart'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'web/cart/basket.ts'), Array.from({ length: 40 }, (_, i) => `line ${i} of basket`).join('\n'))
  fs.writeFileSync(path.join(repo, 'a.go'), Array.from({ length: 40 }, (_, i) => `line ${i} of a`).join('\n'))
  git('add', '.'); git('commit', '-qm', 'one')
  const base = git('rev-parse', '--short', 'HEAD').toString().trim()
  git('mv', 'a.go', 'b.go'); git('commit', '-qm', 'two')
  git('mv', 'web/cart/basket.ts', 'web/cart/cartLines.ts') // staged, not committed
  const m = await gitRenames(repo, base)
  assert.equal(m.get('a.go'), 'b.go', 'a rename committed since the journey\'s commit')
  assert.equal(m.get('web/cart/basket.ts'), 'web/cart/cartLines.ts', 'a staged git mv')
  assert.equal((await gitRenames(path.join(repo, 'nope'))).size, 0, 'no repo: nothing, no error')
  fs.rmSync(repo, { recursive: true, force: true })
})

test('a "since" that is not a commit: the recent history is read instead', async () => {
  const { repo } = repoWithRename()
  try {
    assert.equal((await gitRenames(repo, 'not-a-hash')).get('a.go'), 'b.go')
    assert.equal((await gitRenames(repo, 'deadbeef')).get('a.go'), 'b.go', 'an unknown hash')
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('renames before "since" are not reported', async () => {
  const { repo, git } = repoWithRename()
  try {
    const head = git('rev-parse', 'HEAD').toString().trim()
    assert.equal((await gitRenames(repo, head)).size, 0)
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})
