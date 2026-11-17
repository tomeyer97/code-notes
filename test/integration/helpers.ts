// What every integration entry point (suite.ts, check.ts, untrusted.ts, roundTrips.ts) shares: the waits, the test
// runner, the extension's id, the fake Claude's log and the screenshots.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import assert from 'assert'
import type { TestApi } from '../../src/testApi'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits are tuned for a fast machine; CI (or CODE_NOTES_TIMEOUT_SCALE=n) gives every wait n times longer. */
export const SCALE = Number(process.env.CODE_NOTES_TIMEOUT_SCALE) || (process.env.CI ? 3 : 1)

export type Until = <T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms?: number) => Promise<T>

/** How long a wait waits by default (× SCALE): `waiter()`'s and `untilEqual`'s. */
export const WAIT_MS = 6000

/**
 * A wait for a condition: polls `fn` every 100 ms until it returns something truthy (which it returns), or throws
 * "timed out waiting for: <what>" after `ms` × SCALE. `ms` defaults to the waiter's; `dump`, when given, is printed on
 * a timeout (the state the condition was looking at).
 */
export function waiter(defaults: { ms?: number; dump?: () => unknown } = {}): Until {
  return async (what, fn, ms = defaults.ms ?? WAIT_MS) => {
    const t0 = Date.now()
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() - t0 > ms * SCALE) {
        if (defaults.dump) console.log('state:', JSON.stringify(defaults.dump(), null, 1)?.slice(0, 3000))
        throw new Error(`timed out waiting for: ${what}`)
      }
      await sleep(100)
    }
  }
}

/** The main suite's wait: 6 s by default. */
export const until = waiter()

/**
 * Waits until `get()` deep-equals `want`; on a timeout the failure shows both (where `until` with several clauses
 * joined by && only says it timed out).
 */
export async function untilEqual<T>(what: string, get: () => T, want: T, ms = WAIT_MS): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    let got: T | undefined
    try { got = get() } catch { got = undefined }
    try { assert.deepStrictEqual(got, want); return } catch { /* not yet */ }
    if (Date.now() - t0 > ms * SCALE) assert.deepStrictEqual(got, want, `timed out waiting for: ${what}`)
    await sleep(100)
  }
}

/**
 * A fixed wait before asserting that something did NOT happen (no write, no event, no second message): there is no
 * condition to wait for, only time for a wrong reaction to show up. `ms` is how long the extension would take to
 * react (its debounces are 300-500 ms), scaled by SCALE like every wait; `what` says what must not happen.
 */
export async function quiet(ms: number, what: string): Promise<void> {
  void what
  await sleep(ms * SCALE)
}

/**
 * A fixed wait for something VS Code gives no event for (a reveal's own delayed scrolls, a view laying itself out,
 * focus moving between groups), scaled by SCALE. `why` says what is being waited for.
 */
export async function settle(ms: number, why: string): Promise<void> {
  void why
  await sleep(ms * SCALE)
}

// ---------- the runner ----------

export interface Test {
  name: string
  fn: () => Promise<void | string>
  /** Run only when this says so (e.g. a DevTools connection); otherwise listed as skipped. */
  when?: () => boolean
  whenNot?: string
}

/**
 * One behaviour, named by the sentence that says what it checks. `fn` may return a detail measured on the way
 * (printed after the name). The tests of a suite share one VS Code window and run in order, each starting from the
 * state the previous one left.
 */
export function test(name: string, fn: () => Promise<void | string>, opts: { when?: () => boolean; whenNot?: string } = {}): Test {
  return { name, fn, ...opts }
}

/**
 * Runs the tests in order, printing "✓ <name>" for each. The tests build on each other (one window, one workspace),
 * so the first failure stops the run: it is printed with its error, the tests after it are listed as not run, and the
 * error is thrown (the run fails).
 */
export async function runTests(tests: Test[]): Promise<void> {
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i]
    if (t.when && !t.when()) { console.log(`  - skipped (${t.whenNot ?? 'not here'}): ${t.name}`); continue }
    const t0 = Date.now()
    try {
      const detail = await t.fn()
      console.log(`  ✓ ${t.name}${detail ? `: ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    } catch (e) {
      console.log(`  ✗ ${t.name}`)
      const rest = tests.slice(i + 1)
      if (rest.length) console.log(`  not run (${rest.length}, they build on it):\n${rest.map((r) => `    - ${r.name}`).join('\n')}`)
      throw e
    }
  }
}

// ---------- the extension and its files ----------

export const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
/** The extension's id, from package.json (publisher.name). */
export const EXT_ID = `${pkg.publisher}.${pkg.name}`

/** The extension activated: its test API (src/testApi.ts, the object `activate` returns). */
export async function activate(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>(EXT_ID)!.activate()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'))
/** `readJson`, or undefined while the file is missing or half-written. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readJsonOr = (p: string): any => { try { return readJson(p) } catch { return undefined } }

/** Appends a message to a note file, as an agent (or the person, in another window) would. */
export function appendMessage(notePath: string, msg: object): void {
  const d = readJson(notePath)
  d.messages.push(msg)
  fs.writeFileSync(notePath, JSON.stringify(d, null, 2))
}

export const now = () => new Date().toISOString()
export const linesOf = (d: vscode.TextDocument) => Array.from({ length: d.lineCount }, (_, i) => d.lineAt(i).text)

// ---------- the fake Claude (test/fixtures/fake-claude.js) ----------

/** Every run of the fake claude CLI so far (its log, FAKE_CLAUDE_LOG): each one's arguments. */
export function fakeCalls(): string[][] {
  const log = process.env.FAKE_CLAUDE_LOG
  if (!log || !fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** The runs that were asked something (`-p <prompt>`), not the version probes. */
export const claudeRuns = () => fakeCalls().filter((a) => a.includes('-p'))

/** The value after `name` in a command line (`flag(args, '-p')`: the prompt). */
export const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

// ---------- the window ----------

/** Focuses the editor group in `column` (1-4). */
export const focusGroup = (column: number) => vscode.commands.executeCommand(`workbench.action.focus${['First', 'Second', 'Third', 'Fourth'][column - 1]}EditorGroup`)

/**
 * A picture of the whole X display (xvfb + ImageMagick's `import`), for a person to look at, when the environment
 * variable `dirVar` names a folder (CODE_NOTES_SHOTS by default). `wait` lets the window paint first.
 */
export async function windowShot(name: string, { dirVar = 'CODE_NOTES_SHOTS', wait = 1200 } = {}): Promise<void> {
  const d = process.env[dirVar]
  if (!d) return
  await sleep(wait)
  execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)])
}
