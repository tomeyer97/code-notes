// The integration suites' runner. A suite is a list of chapters (a name, the file, what it covers, its tests); the
// suite's table of chapters is the one list it runs, and it prints itself at the start of a run. No VS Code API here
// (unit-tested).

export interface Test {
  name: string
  fn: () => Promise<void | string>
  /** Run only when this says so (e.g. a DevTools connection); otherwise listed as skipped. */
  when?: () => boolean
  whenNot?: string
  /** Undoes what the test changed in the shared window, run after it whether it passed or failed. */
  cleanup?: () => unknown | Promise<unknown>
}

export type TestOptions = Pick<Test, 'when' | 'whenNot' | 'cleanup'>

/**
 * One behaviour, named by the sentence that says what it checks. `fn` may return a detail measured on the way
 * (printed after the name). The tests of a suite share one VS Code window and run in order.
 */
export function test(name: string, fn: () => Promise<void | string>, opts: TestOptions = {}): Test {
  return { name, fn, ...opts }
}

/** A suite's chapter: a test file's tests, run in the suite's order. */
export interface Chapter {
  /** The name ONLY=<name> picks it by. */
  name: string
  /** The test file, relative to test/integration/. */
  file: string
  /** What it covers (and, for the main suite, the source it covers most). */
  covers: string
  tests: Test[]
  /** Run before the chapter's tests, so the chapter can run alone (ONLY=<name>) as well as after the ones before it. */
  setup?: () => Promise<void>
}

/** The table of chapters, as printed at the start of a run. */
export function chapterTable(chapters: Chapter[]): string {
  const w = Math.max(...chapters.map((c) => c.file.length))
  return chapters.map((c) => `  ${c.file.padEnd(w)}  ${c.covers}`).join('\n')
}

/** The chapters `only` names (all with none); throws on a name no chapter has. */
export function pickChapters(chapters: Chapter[], only: string[] | undefined): Chapter[] {
  if (!only) return chapters
  const unknown = only.filter((n) => !chapters.some((c) => c.name === n))
  if (unknown.length) throw new Error(`no chapter ${unknown.join(', ')} (the chapters: ${chapters.map((c) => c.name).join(', ')})`)
  return chapters.filter((c) => only.includes(c.name))
}

/** Work run after every test (e.g. undoing a wrapper a test forgot to dispose); registered by the helpers. */
const afterEachTest: (() => void)[] = []
export function afterEveryTest(fn: () => void): void { afterEachTest.push(fn) }

export interface RunOptions {
  /** After a failure, run the rest anyway (CODE_NOTES_KEEP_GOING=1); the run still fails at the end. */
  keepGoing?: boolean
  log?: (line: string) => void
}

/**
 * Runs the tests in order, printing "✓ <name>" for each. The tests share one window, so by default the first failure
 * stops the run: it is printed with its error, the tests after it are listed as not run, and the error is thrown.
 * With `keepGoing` the rest run too and the first error is thrown at the end.
 */
export async function runTests(tests: Test[], { keepGoing = false, log = console.log }: RunOptions = {}): Promise<void> {
  const failed: { name: string; error: unknown }[] = []
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i]
    if (t.when && !t.when()) { log(`  - skipped (${t.whenNot ?? 'not here'}): ${t.name}`); continue }
    const t0 = Date.now()
    let error: unknown
    let detail: void | string = undefined
    try { detail = await t.fn() } catch (e) { error = e }
    try { await t.cleanup?.() } catch (e) { error ??= e }
    for (const after of afterEachTest) after()
    if (error === undefined) { log(`  ✓ ${t.name}${detail ? `: ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); continue }
    log(`  ✗ ${t.name}`)
    if (keepGoing) { log(`    ${String((error as Error)?.stack ?? error)}`); failed.push({ name: t.name, error }); continue }
    const rest = tests.slice(i + 1)
    if (rest.length) log(`  not run (${rest.length}, they build on it):\n${rest.map((r) => `    - ${r.name}`).join('\n')}`)
    throw error
  }
  if (failed.length) {
    log(`  ${failed.length} failed:\n${failed.map((f) => `    - ${f.name}`).join('\n')}`)
    throw failed[0].error
  }
}

/** A chapter's setup as a test of its own (named after the chapter), so a failing setup is reported like a test. */
const setupTest = (c: Chapter): Test[] => (c.setup ? [test(`(${c.name}: setup)`, async () => { await c.setup!() })] : [])

/**
 * Runs a suite: prints its table of chapters, then the chapters `only` picks (all by default), each one's setup first.
 */
export async function runChapters(title: string, chapters: Chapter[], { only, ...opts }: RunOptions & { only?: string[] } = {}): Promise<void> {
  const log = opts.log ?? console.log
  log(`${title}\n${chapterTable(chapters)}`)
  const picked = pickChapters(chapters, only)
  if (only) log(`  only: ${picked.map((c) => c.name).join(', ')}`)
  await runTests(picked.flatMap((c) => [...setupTest(c), ...c.tests]), opts)
}
