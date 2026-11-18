// What the integration suites (suite.ts with main/, check/, untrusted.ts) share: the waits, the test runner, the
// extension's id, the fake Claude's log, the window's calls and the screenshots.
//
// The environment variables the integration tests read (run.ts passes them on to VS Code):
//   CODE_NOTES_TIMEOUT_SCALE=n   every wait n times longer (CI=1 alone gives 3)
//   CODE_NOTES_SHOTS=<dir>       pictures of the window at named moments (`windowShot`, devtools.ts `pageShot`)
//   CODE_NOTES_ANIM_SHOTS=<dir>  pictures of the animation tests' states (main/animation.ts)
//   CODE_NOTES_RTT_MS=<ms>       each call into the window waits that long, as over a slow remote link (`callCounter`)
//   CODE_NOTES_PROFILE=<dir>     keep VS Code's profiles (user data) there instead of in temp folders (run.ts)
//   CODE_NOTES_CONSOLE_ALL=1     print every workbench console message, not only the errors (run.ts, check run)
//   ONLY_MAIN / ONLY_UNTRUSTED / ONLY_CHECK=1   run that suite alone (run.ts; with none set, all three)
//   ONLY_PODCAST=1               in the main suite, only the podcast's tests (suite.ts)
// Set by run.ts or the tests themselves, not by hand:
//   CODE_NOTES_CDP               the workbench's DevTools port (main and check runs: devtools.ts)
//   CODE_NOTES_CONSOLE           the file the workbench console errors are collected in (check run)
//   CODE_NOTES_SLOW_GIT          a folder with a slow `git` (check run: check/refresh.ts)
//   FAKE_CLAUDE_LOG              the fake claude CLI's log of its runs (`useFakeClaude`, `fakeCalls`)
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

/** How long a wait waits by default (× SCALE): `waiter()`'s and `untilEqual`'s. Each suite makes its own `until`
 *  with `waiter` (main/context.ts, check/context.ts, untrusted.ts). */
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

// ---------- calls into the window ----------

/** The calls as one list: each one, or (more than 12) "n× <kind> <target>" per kind. */
function callList(calls: string[]): string {
  if (calls.length <= 12) return calls.join(', ')
  const perKind: Record<string, number> = {}
  for (const call of calls) {
    const kind = call.split(' ').slice(0, 2).join(' ')
    perKind[kind] = (perKind[kind] ?? 0) + 1
  }
  return Object.entries(perKind).map(([kind, n]) => `${n}× ${kind}`).join(', ')
}

/**
 * Counts (and with CODE_NOTES_RTT_MS set, delays) the calls into the window the extension makes while `measure` runs
 * an action. Over Remote-SSH each awaited call into the window is one network round trip (main/roundTrips.ts).
 */
export function callCounter(api: { mementos?: () => vscode.Memento[] }) {
  const rtt = Number(process.env.CODE_NOTES_RTT_MS) || 0
  let calls: string[] = []
  let on = false
  const undo: (() => void)[] = []
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const wrap = (obj: any, name: string, label: (...a: any[]) => string | undefined) => {
    const orig = obj[name]
    obj[name] = function (this: unknown, ...a: any[]) {
      const l = on ? label(...a) : undefined
      if (!l) return orig.apply(this, a)
      calls.push(l)
      const r = orig.apply(this, a)
      return rtt ? Promise.resolve(r).then(async (v: unknown) => { await sleep(rtt); return v }) : r
    }
    undo.push(() => { obj[name] = orig })
  }
  const known = (u: vscode.Uri) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())
  wrap(vscode.window, 'showTextDocument', (u: any) => `show ${path.basename((u?.uri ?? u)?.path ?? '')}`)
  // Already open: the extension host has it, nothing goes to the window.
  wrap(vscode.workspace, 'openTextDocument', (u: any) => (u instanceof vscode.Uri && !known(u) ? `open ${path.basename(u.path)}` : undefined))
  // Commands the extension registered itself run in the extension host; the window's own ones (setContext, focus, …) don't.
  wrap(vscode.commands, 'executeCommand', (id: string, ...a: any[]) => (id.startsWith('codeNotes.') && !id.endsWith('.focus') ? undefined : `command ${id}${id === 'setContext' ? ` ${a[0]}` : ''}`))
  for (const m of api.mementos?.() ?? []) wrap(m, 'update', (k: string) => `store ${k}`)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return {
    rtt,
    /** Runs `run`, then waits (25 ms polls, 5 s at most) until `settled`; prints and returns the calls it made. */
    async measure(what: string, run: () => PromiseLike<unknown>, settled: () => boolean | Promise<boolean>): Promise<{ calls: string[]; ms: number }> {
      calls = []
      on = true
      const t0 = Date.now()
      try {
        await run()
        for (let i = 0; i < 200 && !(await settled()); i++) await sleep(25)
      } finally { on = false }
      const ms = Date.now() - t0
      const count = `${calls.length} call${calls.length === 1 ? '' : 's'} into the window`
      const slowLink = rtt ? ` with ${rtt} ms per round trip` : ''
      const list = calls.length ? ` (${callList(calls)})` : ''
      console.log(`    ${what}: ${count}, ${ms} ms${slowLink}${list}`)
      return { calls: [...calls], ms }
    },
    dispose() { for (const u of undo.splice(0)) u() },
  }
}
