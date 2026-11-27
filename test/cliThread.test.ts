import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { CliThread } from '../src/check/cliThread'
import { refreshInputs } from '../cli/understanding/state'
import { gitRepo } from './helpers/gitRepo'
import { writeSlowGit } from './slowGit'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A repository on a branch with a change; `slow`: a `git` on PATH that takes that many seconds per call. */
function repo(slow?: number) {
  const r = gitRepo({ prefix: 'cli-thread-' })
  r.git('checkout', '-qb', 'feat/x')
  r.commit('two', { 'a.js': Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i}`).join('\n') + '\n' })
  if (slow === undefined) return r
  const bin = path.join(r.dir, '.bin')
  fs.mkdirSync(bin)
  writeSlowGit(bin, slow)
  return { ...r, env: { ...r.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
}

test('the CLI runs on the worker: this thread goes on while git is slow', async () => {
  const { dir, env } = repo(0.15)
  const t = new CliThread(env)
  try {
    // A dozen git calls of 0.15 s each: this thread's timers run in between (a git run on this thread would hold
    // them until the status is read).
    let settled = false
    const call = t.api.refreshState(dir, {}).finally(() => { settled = true })
    let ticks = 0
    while (!settled && ticks < 3) { await sleep(1); ticks++ }
    assert.equal(settled, false, 'timers ran while the worker read the status')
    const r = await call
    assert.equal(r.st?.branch, 'feat/x')
    assert.equal(r.st?.state.phase, 'none')
    assert.equal(r.ident?.name, 'A')
  } finally { t.dispose() }
})

test('nothing changed: the refresh stops at its key; a change, a commit or a new check file goes through', async () => {
  const { dir, git } = repo()
  const t = new CliThread()
  try {
    const a = await t.api.refreshState(dir, {})
    assert.ok(a.key && !a.same && a.st)
    const b = await t.api.refreshState(dir, { prev: a.key })
    assert.deepEqual(b, { key: a.key, same: true }, 'unchanged')
    // `git status` (a Git view, a terminal) changes nothing the check shows.
    git('status'); git('status', '--porcelain')
    assert.equal((await t.api.refreshState(dir, { prev: a.key })).same, true, 'after git status')
    // A file of the change edited, uncommitted: again (twice in a row: the second edit changes no `git status` line).
    fs.appendFileSync(path.join(dir, 'a.js'), 'export const b = 2\n')
    const c = await t.api.refreshState(dir, { prev: a.key })
    assert.ok(!c.same && c.st && c.key !== a.key, 'an edit')
    await sleep(20)
    fs.appendFileSync(path.join(dir, 'a.js'), 'export const c = 3\n')
    const d = await t.api.refreshState(dir, { prev: c.key })
    assert.ok(!d.same, 'a second edit of the same file')
    git('commit', '-qam', 'three')
    const e = await t.api.refreshState(dir, { prev: d.key })
    assert.ok(!e.same, 'a commit')
    fs.mkdirSync(path.join(dir, 'understanding'))
    fs.writeFileSync(path.join(dir, 'understanding', 'feat-x.json'), '{}\n')
    const f = await t.api.refreshState(dir, { prev: e.key })
    assert.ok(!f.same && f.st?.exists, 'the check file (untracked)')
    // A file the caller names (an applied fix, a TODO), and what only the caller knows (`extra`).
    fs.writeFileSync(path.join(dir, 'fix.js'), 'x\n')
    assert.equal((await t.api.refreshState(dir, { prev: f.key })).same, true, 'an untracked file nobody asked about')
    assert.ok(!(await t.api.refreshState(dir, { prev: f.key, files: ['fix.js'] })).same, 'a named file')
    assert.ok(!(await t.api.refreshState(dir, { prev: f.key, extra: 'fix.js' })).same, 'extra')
    // Who answers: git's config.
    git('config', 'user.name', 'B')
    const g = await t.api.refreshState(dir, { prev: f.key })
    assert.ok(!g.same && g.ident?.name === 'B', 'a new identity')
  } finally { t.dispose() }
})

test('every file and ref the CLI says a status reads changes the key', async () => {
  const { dir, git } = repo()
  const t = new CliThread()
  try {
    const inputs = refreshInputs(dir)
    assert.equal(inputs.branch, 'feat/x')
    assert.ok(inputs.files.includes('understanding/config.json') && inputs.files.includes('understanding/feat-x.json'))
    let key = (await t.api.refreshState(dir, {})).key
    // Ignored, so `git status` doesn't see them: only the gate's own list of inputs does.
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'understanding/\n.code-notes/\n')
    key = (await t.api.refreshState(dir, {})).key
    for (const f of inputs.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), '{}\n')
      const r = await t.api.refreshState(dir, { prev: key })
      assert.ok(!r.same, f)
      key = r.key
    }
    // The base branch's candidates (origin/main here: refs/remotes/origin/main is one of the refs).
    assert.ok(inputs.refs.includes('refs/remotes/origin/main'))
    git('update-ref', 'refs/remotes/origin/main', 'main')
    assert.ok(!(await t.api.refreshState(dir, { prev: key })).same, 'a base ref')
  } finally { t.dispose() }
})

test('the worker never takes the index lock for a status read', async () => {
  const { dir } = repo()
  const t = new CliThread()
  try {
    fs.appendFileSync(path.join(dir, 'a.js'), '// more\n')
    // A stale index (the file's time changed): a plain `git status` would write it.
    const index = path.join(dir, '.git', 'index')
    const before = fs.statSync(index).mtimeMs
    await sleep(20)
    await t.api.refreshState(dir, {})
    assert.equal(fs.statSync(index).mtimeMs, before, '.git/index untouched')
  } finally { t.dispose() }
})

test('a function that throws: its error comes back; the worker goes on', async () => {
  const { dir } = repo()
  const t = new CliThread()
  try {
    await assert.rejects(t.api.diffText(dir, 'no-such-ref'), /no-such-ref/)
    // Only the worker's API answers: a name from the other side that isn't in it is refused.
    const raw = t.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await assert.rejects(raw.noSuchFunction(), /no function noSuchFunction/)
    const inherited: string = 'toString'
    await assert.rejects(raw[inherited](), /no function toString/)
    assert.deepEqual(await t.api.codeStat(dir, 'main', 'HEAD'), {
      files: 1, added: 30, removed: 1, exempt: [], exemptOnly: false, docsOnly: false, renamed: [],
    })
  } finally { t.dispose() }
})

test('the typed proxy is not a thenable', async () => {
  const t = new CliThread()
  try {
    assert.equal((t.api as unknown as { then?: unknown }).then, undefined)
    assert.equal(await Promise.resolve(t.api), t.api)
  } finally { t.dispose() }
})
