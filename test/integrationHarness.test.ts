// The integration harness's own parts that need no VS Code: the environment it reads, the runner, the waits, the
// DevTools port and the suites' workspaces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { onlyChapters, readTestEnv, selectedSuites } from './integration/support/testEnv'
import { Chapter, chapterTable, pickChapters, runChapters, runTests, test as itest } from './integration/support/runner'
import { untilAll, untilEqual, waiter } from './integration/support/waits'
import { freePort } from './integration/support/freePort'
import { CHECK_AUTHOR, CHECK_BRANCH, makeCheckRepo, makeMainWorkspace, makeUntrustedWorkspace } from './integration/fixtures'

test('suites: SUITES, argv and the older ONLY_<SUITE> add up, in the suites\' own order; none picks all', () => {
  assert.deepEqual(selectedSuites({}), ['main', 'untrusted', 'check'])
  assert.deepEqual(selectedSuites({ SUITES: 'check,main' }), ['main', 'check'])
  assert.deepEqual(selectedSuites({ ONLY_MAIN: '1', ONLY_CHECK: '1' }), ['main', 'check'])
  assert.deepEqual(selectedSuites({ ONLY_UNTRUSTED: '1' }, ['check']), ['untrusted', 'check'])
  assert.deepEqual(selectedSuites({}, ['--help']), ['main', 'untrusted', 'check'])
  assert.throws(() => selectedSuites({ SUITES: 'mian' }), /unknown suite mian/)
})

test('ONLY picks chapters; ONLY_PODCAST is its older spelling for the podcast chapters', () => {
  assert.equal(onlyChapters({}), undefined)
  assert.deepEqual(onlyChapters({ ONLY: 'notes, requests' }), ['notes', 'requests'])
  assert.deepEqual(onlyChapters({ ONLY_PODCAST: '1' }), ['podcast', 'listenEditor'])
  assert.deepEqual(onlyChapters({ ONLY_PODCAST: 'editor' }), ['listenEditor'])
})

test('the environment is read when asked (a variable set during the run counts); CI alone scales waits by 3', () => {
  const env: Record<string, string | undefined> = {}
  const e = readTestEnv(env)
  assert.equal(e.timeoutScale, 1)
  env.CI = 'true'
  assert.equal(e.timeoutScale, 3)
  env.CODE_NOTES_TIMEOUT_SCALE = '5'
  assert.equal(e.timeoutScale, 5)
  assert.equal(e.fakeClaudeLog, undefined)
  env.FAKE_CLAUDE_LOG = '/tmp/x.log'
  assert.equal(e.fakeClaudeLog, '/tmp/x.log')
  assert.equal(e.rttMs, 0)
  assert.equal(e.keepGoing, false)
})

const quietLog = () => { const lines: string[] = []; return { lines, log: (l: string) => { lines.push(l) } } }

test('the runner stops at the first failure and lists what did not run; cleanup runs either way', async () => {
  const ran: string[] = []
  const { lines, log } = quietLog()
  const tests = [
    itest('one', async () => { ran.push('one') }, { cleanup: () => ran.push('clean one') }),
    itest('two', async () => { throw new Error('boom') }, { cleanup: () => ran.push('clean two') }),
    itest('three', async () => { ran.push('three') }),
  ]
  await assert.rejects(runTests(tests, { log }), /boom/)
  assert.deepEqual(ran, ['one', 'clean one', 'clean two'])
  assert.ok(lines.some((l) => /not run \(1, they build on it\):\n {4}- three/.test(l)), lines.join('\n'))
})

test('keep going: the tests after a failure run too, and the run still fails with the first error', async () => {
  const ran: string[] = []
  const { lines, log } = quietLog()
  const tests = [
    itest('a', async () => { throw new Error('first') }),
    itest('b', async () => { ran.push('b') }),
    itest('c', async () => { throw new Error('second') }),
  ]
  await assert.rejects(runTests(tests, { log, keepGoing: true }), /first/)
  assert.deepEqual(ran, ['b'])
  assert.ok(lines.some((l) => l.includes('2 failed')), lines.join('\n'))
})

test('a failing cleanup fails its test; a skipped test says why', async () => {
  const { lines, log } = quietLog()
  await assert.rejects(runTests([itest('x', async () => undefined, { cleanup: () => { throw new Error('undo failed') } })], { log }), /undo failed/)
  await runTests([itest('y', async () => undefined, { when: () => false, whenNot: 'no DevTools' })], { log })
  assert.ok(lines.includes('  - skipped (no DevTools): y'))
})

test('chapters: the table is printed from the one list, ONLY picks by name, each picked chapter\'s setup runs first', async () => {
  const ran: string[] = []
  const chapters: Chapter[] = [
    { name: 'first', file: 'main/first.ts', covers: 'the first', tests: [itest('f', async () => { ran.push('f') })] },
    { name: 'second', file: 'main/second.ts', covers: 'the second', tests: [itest('s', async () => { ran.push('s') })], setup: async () => { ran.push('setup') } },
  ]
  assert.equal(chapterTable(chapters), '  main/first.ts   the first\n  main/second.ts  the second')
  assert.deepEqual(pickChapters(chapters, ['second']).map((c) => c.name), ['second'])
  assert.throws(() => pickChapters(chapters, ['third']), /no chapter third \(the chapters: first, second\)/)
  const { lines, log } = quietLog()
  await runChapters('suite', chapters, { only: ['second'], log })
  assert.deepEqual(ran, ['setup', 's'])
  assert.ok(lines[0].startsWith('suite\n  main/first.ts'))
})

test('untilAll names the clauses still false when it times out', async () => {
  let n = 0
  await untilAll('both', { counted: () => ++n > 2, always: () => true }, 2000, 1)
  await assert.rejects(untilAll('the note shown', { saved: () => true, shown: () => false, open: () => { throw new Error('x') } }, 150, 1),
    { message: 'timed out waiting for: the note shown (still false: shown, open)' })
})

test('waiter returns the condition\'s value; untilEqual shows what it got', async () => {
  const until = waiter({ ms: 150, scale: 1 })
  assert.equal(await until('a value', () => 'x'), 'x')
  await assert.rejects(until('nothing', () => false), /timed out waiting for: nothing/)
  await assert.rejects(untilEqual('two', () => 1, 2, 150, 1), /timed out waiting for: two/)
})

test('freePort gives a port nobody listens on', async () => {
  const port = await freePort()
  assert.ok(port > 0)
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer().on('error', reject).listen(port, '127.0.0.1', () => s.close(() => resolve()))
  })
})

test('the suites\' workspaces: main\'s src/app.ts, the untrusted folder\'s own claude.path and skill stand-in', () => {
  const main = makeMainWorkspace()
  assert.equal(fs.readFileSync(path.join(main, 'src', 'app.ts'), 'utf8'),
    'import { readToken, use } from "./lib"\nexport function main() {\n  const token = readToken()\n  use(token)\n  return 0\n}\n')
  const untrusted = makeUntrustedWorkspace()
  assert.equal(fs.readFileSync(path.join(untrusted, 'src', 'app.ts'), 'utf8'), 'export function main() {\n  return 0\n}\n')
  assert.match(fs.readFileSync(path.join(untrusted, '.vscode', 'settings.json'), 'utf8'), /evil\.sh/)
  assert.ok(fs.existsSync(path.join(untrusted, '.claude', 'skills', 'code-journey', 'scripts', 'journey.py')))
  for (const d of [main, untrusted]) fs.rmSync(d, { recursive: true, force: true })
})

test('the check\'s repository: main, then the change on its branch by its author, .vscode excluded, a remote', () => {
  const ws = makeCheckRepo()
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' }).trim()
  try {
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), CHECK_BRANCH)
    assert.equal(git('log', '--format=%s %an <%ae>', 'main..HEAD'), `limits ${CHECK_AUTHOR.name} <${CHECK_AUTHOR.email}>`)
    assert.equal(git('diff', '--name-only', 'main', 'HEAD'), 'api/limits.js')
    assert.equal(git('config', 'user.name'), CHECK_AUTHOR.name)
    assert.match(fs.readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8'), /^\.vscode\/$/m)
    const remote = git('remote', 'get-url', 'origin')
    assert.equal(execFileSync('git', ['rev-parse', '--is-bare-repository'], { cwd: remote, encoding: 'utf8' }).trim(), 'true')
    fs.rmSync(remote, { recursive: true, force: true })
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})
