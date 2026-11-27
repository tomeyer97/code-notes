// Questions written in the background after a push: only in a repository that uses the check
// (src/check/backgroundRule.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import { BackgroundWrites, type PushedPorts, usesCheck } from '../src/check/backgroundRule'
import type { CheckState } from '../src/check/state'
import type { BranchStatus } from '../src/check/types'
import { gitRepo } from './helpers/gitRepo'

/** A branch with a change and no check, pushed; `usesCheck`: what the repository says. */
function fakeRepo(o: { usesCheck: boolean; st?: Partial<BranchStatus>; enabled?: boolean }) {
  const st = { branch: 'feat/x', file: 'understanding/feat-x.json', changed: 12, exists: false, baseRef: 'origin/main', state: { phase: 'none' }, ...o.st } as BranchStatus
  const stored = new Map<string, unknown>()
  const writes: unknown[] = []
  const asked: string[][] = []
  const ports: PushedPorts = {
    state: { st } as CheckState,
    refresh: async () => undefined,
    stored: { get: (k) => (stored.get(k.key) ?? k.fallback) as never, set: async (k, v) => { stored.set(k.key, v) } },
    enabled: () => o.enabled ?? true,
    usesCheck: async (refs) => { asked.push(refs); return o.usesCheck },
    writer: { writing: undefined, write: async (...a: unknown[]) => { writes.push(a) } } as unknown as PushedPorts['writer'],
  }
  return { bg: new BackgroundWrites(ports), writes, asked }
}

test('a push in a repository that does not use the check starts no background run', async () => {
  const r = fakeRepo({ usesCheck: false })
  assert.equal(await r.bg.pushed('feat/x', 'c1'), false)
  assert.equal(r.writes.length, 0)
  assert.deepEqual(r.asked, [['HEAD', 'origin/main']], 'asked about HEAD and the branch compared with')
})

test('a push in a repository that uses the check writes its questions, once per commit', async () => {
  const r = fakeRepo({ usesCheck: true })
  assert.equal(await r.bg.pushed('feat/x', 'c1'), true)
  assert.equal(await r.bg.pushed('feat/x', 'c1'), false, 'the same commit again: no second run')
  assert.deepEqual(r.writes, [[false, { background: true }]])
})

test('no run on a default branch, with the setting off, or when the branch has a check', async () => {
  for (const r of [
    fakeRepo({ usesCheck: true, st: { onBase: true } }),
    fakeRepo({ usesCheck: true, enabled: false }),
    fakeRepo({ usesCheck: true, st: { exists: true, state: { phase: 'answering' } as BranchStatus['state'] } }),
  ]) {
    assert.equal(await r.bg.pushed('feat/x', 'c1'), false)
    assert.equal(r.writes.length, 0)
  }
})

test('usesCheck: understanding/config.json, or a check file committed at a ref; nothing else', async () => {
  const repo = gitRepo({ prefix: 'uses-check-' })
  try {
    assert.equal(await usesCheck(repo.dir, ['HEAD', 'main']), false, 'a repository without the check')
    assert.equal(await usesCheck(repo.dir, ['no-such-ref']), false, 'a ref that does not exist')
    repo.write({ 'understanding/config.json': '{}' })
    assert.equal(await usesCheck(repo.dir, []), true, 'its settings, even uncommitted')
    fs.rmSync(`${repo.dir}/understanding`, { recursive: true })
    repo.git('checkout', '-q', '-b', 'feat/a')
    repo.commit('check', { 'understanding/feat-a.json': '{}' })
    repo.git('checkout', '-q', 'main')
    assert.equal(await usesCheck(repo.dir, ['HEAD']), false, 'not committed on main')
    assert.equal(await usesCheck(repo.dir, ['HEAD', 'feat/a']), true, 'committed at feat/a')
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true })
  }
})
