// Commit & push's git calls on the extension host (src/check/pushGit.ts), on scratch repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { PushGit } from '../src/check/pushGit'
import { gitRepo } from './helpers/gitRepo'

test('changed: the files git lists as changed or new, in one call; unchanged and missing ones are not', async () => {
  const r = gitRepo({ prefix: 'cn-pushgit-', files: { 'a.js': 'a\n', 'b.js': 'b\n' } })
  try {
    r.write({ 'a.js': 'a2\n', 'new/c.js': 'c\n' })
    const changed = await new PushGit(r.dir).changed(['a.js', 'b.js', 'new/c.js', 'gone.js'])
    assert.deepEqual([...changed].sort(), ['a.js', 'new/c.js'])
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true })
  }
})

test('changed: from a folder below the repository\'s root, its own paths', async () => {
  const r = gitRepo({ prefix: 'cn-pushgit-', files: { 'app/a.js': 'a\n', 'a.js': 'root\n' } })
  try {
    r.write({ 'app/a.js': 'a2\n' })
    const changed = await new PushGit(path.join(r.dir, 'app')).changed(['a.js'])
    assert.deepEqual([...changed], ['a.js'])
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true })
  }
})

test('ahead: undefined without an upstream; committed: the file at HEAD; not merging', async () => {
  const r = gitRepo({ prefix: 'cn-pushgit-', files: { 'a.js': 'a\n' } })
  try {
    const git = new PushGit(r.dir)
    assert.equal(await git.ahead(), undefined)
    assert.equal(await git.committed('a.js'), 'a')
    assert.equal(await git.committed('nope.js'), undefined)
    assert.equal(await git.merging(), false)
    assert.equal(await git.head(), r.git('rev-parse', 'HEAD'))
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true })
  }
})

test('ahead: the commits HEAD has that its upstream doesn\'t', async () => {
  const r = gitRepo({ prefix: 'cn-pushgit-' })
  try {
    r.git('branch', 'up')
    r.git('branch', '--set-upstream-to=up')
    assert.equal(await new PushGit(r.dir).ahead(), 0)
    r.commit('two', { 'b.js': 'b\n' })
    assert.equal(await new PushGit(r.dir).ahead(), 1)
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true })
  }
})
