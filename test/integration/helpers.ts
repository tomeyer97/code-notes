// What the integration suites (suite.ts with main/, check/, untrusted.ts) share: the waits, the test runner, the
// extension's id, the fake Claude's log, the window's calls and the screenshots. The environment variables they read:
// support/testEnv.ts (`node out/test/integration/run.js --help` lists them).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import type { TestApi } from '../../src/testApi'
import { testEnv } from './support/testEnv'
import { RunOptions, Test, afterEveryTest, runChapters as runChaptersWith, runTests as runTestsWith } from './support/runner'
import { unscaledSleep } from './support/waits'
import { SuiteContext, createSuiteContext as createContextWith } from './support/suiteContext'

export { SCALE, WAIT_MS, Until, waiter, untilAll, untilEqual, quiet, settle } from './support/waits'
export { Chapter, Test, test, chapterTable } from './support/runner'
export type { SuiteContext } from './support/suiteContext'

/** @deprecated Unscaled and without a reason: use `settle(ms, why)` or `quiet(ms, what)`. Kept for its callers. */
export const sleep = unscaledSleep

/** Runs the tests in order (support/runner.ts); CODE_NOTES_KEEP_GOING=1 runs the rest after a failure too. */
export const runTests = (tests: Test[], opts: RunOptions = {}) => runTestsWith(tests, { keepGoing: testEnv.keepGoing, ...opts })

/**
 * Runs a suite's chapters (support/runner.ts): the ones ONLY names, or all; CODE_NOTES_KEEP_GOING=1 as in `runTests`.
 * A `scenario` (chapters that build on each other) always runs whole: ONLY does not apply to it.
 */
export async function runChapters(title: string, chapters: Parameters<typeof runChaptersWith>[1], { scenario = false } = {}): Promise<void> {
  if (scenario && testEnv.only) console.log(`  (ONLY does not apply here: the chapters are one scenario)`)
  await runChaptersWith(title, chapters, { keepGoing: testEnv.keepGoing, only: scenario ? undefined : testEnv.only })
}

// ---------- the extension and its files ----------

export const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
/** The extension's id, from package.json (publisher.name). */
export const EXT_ID = `${pkg.publisher}.${pkg.name}`

/** The extension activated: its test API (src/testApi.ts, the object `activate` returns). */
export async function activate(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>(EXT_ID)!.activate()
}

/** The extension activated, with the workspace and the suite's wait: what every suite starts from. */
export function createSuiteContext(opts: { waitMs?: number; dump?: (api: TestApi) => unknown } = {}): Promise<SuiteContext> {
  return createContextWith(activate, opts)
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
  const log = testEnv.fakeClaudeLog
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

/** How long a window picture waits by default for the window to paint (its views redraw a moment after a change). */
const PAINT_MS = 1200

/**
 * A picture of the whole X display (xvfb + ImageMagick's `import`), for a person to look at, when the environment
 * variable `dirVar` names a folder (CODE_NOTES_SHOTS by default). `wait` lets the window paint first.
 */
export async function windowShot(name: string, { dirVar = 'CODE_NOTES_SHOTS', wait = PAINT_MS } = {}): Promise<void> {
  const d = process.env[dirVar]
  if (!d) return
  await unscaledSleep(wait)
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
 * The kinds of call `callCounter` records, each call listed as "<kind> <target>": a document shown, a document opened
 * that the extension host did not have, a command the window runs, a memento written.
 */
export const CALL_KIND = { show: 'show', open: 'open', command: 'command', store: 'store' } as const
export type CallKind = keyof typeof CALL_KIND
/** The calls of one kind. */
export const callsOfKind = (calls: string[], kind: CallKind) => calls.filter((c) => c.startsWith(`${CALL_KIND[kind]} `))

/** How often `measure` looks whether the action settled, and how many times at most (5 s in all). */
const MEASURE_POLL_MS = 25
const MEASURE_POLLS = 200

/** Counters not disposed yet: the runner disposes them after each test, so a forgotten one can't wrap later tests. */
const liveCounters = new Set<{ dispose(): void }>()
afterEveryTest(() => {
  if (!liveCounters.size) return
  console.log(`    (a call counter was left on: disposed)`)
  for (const c of [...liveCounters]) c.dispose()
})

/**
 * Counts (and with CODE_NOTES_RTT_MS set, delays) the calls into the window the extension makes while `measure` runs
 * an action. Over Remote-SSH each awaited call into the window is one network round trip (main/roundTrips.ts). It
 * wraps the vscode API in the shared extension host until disposed; the runner disposes it after the test at the
 * latest. `withCallCounter` disposes it when its function returns.
 */
export function callCounter(api: { mementos?: () => vscode.Memento[] }) {
  const rtt = testEnv.rttMs
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
      return rtt ? Promise.resolve(r).then(async (v: unknown) => { await unscaledSleep(rtt); return v }) : r
    }
    undo.push(() => { obj[name] = orig })
  }
  const known = (u: vscode.Uri) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())
  wrap(vscode.window, 'showTextDocument', (u: any) => `${CALL_KIND.show} ${path.basename((u?.uri ?? u)?.path ?? '')}`)
  // Already open: the extension host has it, nothing goes to the window.
  wrap(vscode.workspace, 'openTextDocument', (u: any) => (u instanceof vscode.Uri && !known(u) ? `${CALL_KIND.open} ${path.basename(u.path)}` : undefined))
  // Commands the extension registered itself run in the extension host; the window's own ones (setContext, focus, …) don't.
  wrap(vscode.commands, 'executeCommand', (id: string, ...a: any[]) => (id.startsWith('codeNotes.') && !id.endsWith('.focus') ? undefined : `${CALL_KIND.command} ${id}${id === 'setContext' ? ` ${a[0]}` : ''}`))
  for (const m of api.mementos?.() ?? []) wrap(m, 'update', (k: string) => `${CALL_KIND.store} ${k}`)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const counter = {
    rtt,
    /** Runs `run`, then waits until `settled` (5 s at most); prints and returns the calls it made. */
    async measure(what: string, run: () => PromiseLike<unknown>, settled: () => boolean | Promise<boolean>): Promise<{ calls: string[]; ms: number }> {
      calls = []
      on = true
      const t0 = Date.now()
      try {
        await run()
        for (let i = 0; i < MEASURE_POLLS && !(await settled()); i++) await unscaledSleep(MEASURE_POLL_MS)
      } finally { on = false }
      const ms = Date.now() - t0
      const count = `${calls.length} call${calls.length === 1 ? '' : 's'} into the window`
      const slowLink = rtt ? ` with ${rtt} ms per round trip` : ''
      const list = calls.length ? ` (${callList(calls)})` : ''
      console.log(`    ${what}: ${count}, ${ms} ms${slowLink}${list}`)
      return { calls: [...calls], ms }
    },
    dispose() { liveCounters.delete(counter); for (const u of undo.splice(0)) u() },
  }
  liveCounters.add(counter)
  return counter
}

/** Runs `fn` with a call counter, disposed when `fn` returns or throws. */
export async function withCallCounter<T>(api: { mementos?: () => vscode.Memento[] }, fn: (counter: ReturnType<typeof callCounter>) => Promise<T>): Promise<T> {
  const counter = callCounter(api)
  try { return await fn(counter) } finally { counter.dispose() }
}
