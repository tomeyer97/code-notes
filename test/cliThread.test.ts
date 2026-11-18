import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { CliThread } from '../src/check/cliThread'

const CLI = path.join(__dirname, '../../cli/understanding.mjs')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A repository on a branch with a change, a check file for it, and a `git` on PATH that takes `slow` seconds per call. */
function repo(slow: number): { dir: string; env: NodeJS.ProcessEnv; git: (...a: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-thread-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'A'); git('config', 'user.email', 'a@example.com')
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1\n')
  git('add', '-A'); git('commit', '-qm', 'one')
  git('checkout', '-qb', 'feat/x')
  fs.writeFileSync(path.join(dir, 'a.js'), Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i}`).join('\n') + '\n')
  git('commit', '-qam', 'two')
  const bin = path.join(dir, '.bin')
  fs.mkdirSync(bin)
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep ${slow}\nexec ${real} "$@"\n`, { mode: 0o755 })
  return { dir, env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, git }
}

test('the CLI runs on the worker: a slow git never holds up this thread', async () => {
  const { dir, env } = repo(0.15)
  const t = new CliThread(CLI, env)
  try {
    // The event loop's delay, measured every 5 ms while the status is read (a dozen git calls, 0.15 s each).
    let worst = 0, last = Date.now()
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 5); last = now }, 5)
    const t0 = Date.now()
    const r = await t.call<{ st?: { branch: string; changed: number; state: { phase: string } }; key?: string; ident?: { name?: string } }>('refreshState', dir, {})
    const took = Date.now() - t0
    clearInterval(tick)
    assert.equal(r.st?.branch, 'feat/x')
    assert.equal(r.st?.state.phase, 'none')
    assert.equal(r.ident?.name, 'A')
    assert.ok(took > 1000, `git was slow (${took} ms)`)
    assert.ok(worst < 30, `this thread was held up ${worst} ms`)
  } finally { t.dispose() }
})

test('nothing changed: the refresh stops at its key; a change, a commit or a new check file goes through', async () => {
  const { dir, git } = repo(0)
  const t = new CliThread(CLI)
  try {
    type R = { key?: string; same?: boolean; st?: { exists: boolean; changed: number } }
    const a = await t.call<R>('refreshState', dir, {})
    assert.ok(a.key && !a.same && a.st)
    const b = await t.call<R>('refreshState', dir, { prev: a.key })
    assert.deepEqual(b, { key: a.key, same: true }, 'unchanged')
    // `git status` (a Git view, a terminal) changes nothing the check shows.
    git('status'); git('status', '--porcelain')
    assert.equal((await t.call<R>('refreshState', dir, { prev: a.key })).same, true, 'after git status')
    // A file of the change edited, uncommitted: again (twice in a row: the second edit changes no `git status` line).
    fs.appendFileSync(path.join(dir, 'a.js'), 'export const b = 2\n')
    const c = await t.call<R>('refreshState', dir, { prev: a.key })
    assert.ok(!c.same && c.st && c.key !== a.key, 'an edit')
    await sleep(20)
    fs.appendFileSync(path.join(dir, 'a.js'), 'export const c = 3\n')
    const d = await t.call<R>('refreshState', dir, { prev: c.key })
    assert.ok(!d.same, 'a second edit of the same file')
    git('commit', '-qam', 'three')
    const e = await t.call<R>('refreshState', dir, { prev: d.key })
    assert.ok(!e.same, 'a commit')
    fs.mkdirSync(path.join(dir, 'understanding'))
    fs.writeFileSync(path.join(dir, 'understanding', 'feat-x.json'), '{}\n')
    const f = await t.call<R>('refreshState', dir, { prev: e.key })
    assert.ok(!f.same && f.st?.exists, 'the check file (untracked)')
    // A file the caller names (an applied fix, a TODO), and what only the caller knows (`extra`).
    fs.writeFileSync(path.join(dir, 'fix.js'), 'x\n')
    assert.equal((await t.call<R>('refreshState', dir, { prev: f.key })).same, true, 'an untracked file nobody asked about')
    assert.ok(!(await t.call<R>('refreshState', dir, { prev: f.key, files: ['fix.js'] })).same, 'a named file')
    assert.ok(!(await t.call<R>('refreshState', dir, { prev: f.key, extra: 'fix.js' })).same, 'extra')
    // Who answers: git's config.
    git('config', 'user.name', 'B')
    const g = await t.call<R & { ident?: { name?: string } }>('refreshState', dir, { prev: f.key })
    assert.ok(!g.same && g.ident?.name === 'B', 'a new identity')
  } finally { t.dispose() }
})

test('the worker never takes the index lock for a status read', async () => {
  const { dir } = repo(0)
  const t = new CliThread(CLI)
  try {
    fs.appendFileSync(path.join(dir, 'a.js'), '// more\n')
    // A stale index (the file's time changed): a plain `git status` would write it.
    const index = path.join(dir, '.git', 'index')
    const before = fs.statSync(index).mtimeMs
    await sleep(20)
    await t.call('refreshState', dir, {})
    assert.equal(fs.statSync(index).mtimeMs, before, '.git/index untouched')
  } finally { t.dispose() }
})

test('a function that throws: its error comes back; the worker goes on', async () => {
  const t = new CliThread(CLI)
  try {
    await assert.rejects(t.call('git', os.tmpdir(), ['no-such-command']), /no-such-command/)
    await assert.rejects(t.call('noSuchFunction'), /no function noSuchFunction/)
    assert.equal(await t.call('slugOf', 'feat/A b'), 'feat-a-b')
  } finally { t.dispose() }
})

