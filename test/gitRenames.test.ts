import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { gitRenames } from '../src/gitRenames'

/** git in `repo` as a test user. */
const gitIn = (repo: string) => (...a: string[]) => {
  const user = ['-c', 'user.name=t', '-c', 'user.email=t@t']
  return execFileSync('git', ['-C', repo, ...user, ...a], { stdio: 'pipe' })
}

/** 40 numbered lines of `what`. */
const fortyLines = (what: string) => Array.from({ length: 40 }, (_, i) => `line ${i} of ${what}`).join('\n')

/**
 * A repository with a.go (and the `extra` files: path → text) committed, then a.go renamed to b.go in a second
 * commit; returns it, its git and the first commit.
 */
function repoWithRename(extra: Record<string, string> = {}): { repo: string; git: (...a: string[]) => Buffer; base: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-git-'))
  const git = gitIn(repo)
  git('init', '-q')
  for (const [file, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
  }
  fs.writeFileSync(path.join(repo, 'a.go'), fortyLines('a'))
  git('add', '.')
  git('commit', '-qm', 'one')
  const base = git('rev-parse', '--short', 'HEAD').toString().trim()
  git('mv', 'a.go', 'b.go')
  git('commit', '-qm', 'two')
  return { repo, git, base }
}

test('renames come from git, as journey.py check finds them', async () => {
  const { repo, git, base } = repoWithRename({ 'web/cart/basket.ts': fortyLines('basket') })
  try {
    git('mv', 'web/cart/basket.ts', 'web/cart/cartLines.ts') // staged, not committed
    const m = await gitRenames(repo, base)
    assert.equal(m.get('a.go'), 'b.go', 'a rename committed since the journey\'s commit')
    assert.equal(m.get('web/cart/basket.ts'), 'web/cart/cartLines.ts', 'a staged git mv')
    assert.equal((await gitRenames(path.join(repo, 'nope'))).size, 0, 'no repo: nothing, no error')
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
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
