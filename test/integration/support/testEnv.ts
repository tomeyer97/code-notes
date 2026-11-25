// Every environment variable the integration harness reads, in one place, typed. `node out/test/integration/run.js
// --help` prints `ENV_HELP`. Read the variables through `testEnv`, not process.env: the values are read when asked
// (some are set while the suite runs, e.g. FAKE_CLAUDE_LOG). No VS Code API here: run.ts and the unit tests use it.

/** The suites run.ts can start, in the order they run when none is picked. */
export const SUITE_NAMES = ['main', 'untrusted', 'check'] as const
export type SuiteName = (typeof SUITE_NAMES)[number]

type Env = Record<string, string | undefined>

const num = (env: Env, name: string): number => Number(env[name]) || 0
const str = (env: Env, name: string): string | undefined => env[name] || undefined
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

/** The suites asked for: SUITES=main,check and/or suite names on the command line, plus the older ONLY_<SUITE>=1. */
export function selectedSuites(env: Env, argv: string[] = []): SuiteName[] {
  const asked = new Set([...list(env.SUITES), ...argv.filter((a) => !a.startsWith('-'))])
  for (const s of SUITE_NAMES) if (env[`ONLY_${s.toUpperCase()}`]) asked.add(s)
  const unknown = [...asked].filter((s) => !(SUITE_NAMES as readonly string[]).includes(s))
  if (unknown.length) throw new Error(`unknown suite ${unknown.join(', ')} (the suites: ${SUITE_NAMES.join(', ')})`)
  return asked.size ? SUITE_NAMES.filter((s) => asked.has(s)) : [...SUITE_NAMES]
}

/**
 * The chapters ONLY asks for (ONLY=podcast,listenEditor), or undefined for all. ONLY_PODCAST=1 is the older spelling
 * of ONLY=podcast,listenEditor, and ONLY_PODCAST=editor of ONLY=listenEditor.
 */
export function onlyChapters(env: Env): string[] | undefined {
  const only = list(env.ONLY)
  if (env.ONLY_PODCAST === 'editor') only.push('listenEditor')
  else if (env.ONLY_PODCAST) only.push('podcast', 'listenEditor')
  return only.length ? only : undefined
}

/** The variables, read from `env` (process.env by default) each time one is asked for. */
export function readTestEnv(env: Env = process.env) {
  return {
    /** Every wait this many times longer; CI=1 alone gives 3 (CI machines are slower). */
    get timeoutScale(): number { return num(env, 'CODE_NOTES_TIMEOUT_SCALE') || (env.CI ? 3 : 1) },
    /** A folder for pictures of the window at named moments. */
    get shots(): string | undefined { return str(env, 'CODE_NOTES_SHOTS') },
    /** A folder for pictures of the animation tests' states. */
    get animShots(): string | undefined { return str(env, 'CODE_NOTES_ANIM_SHOTS') },
    /** Each counted call into the window waits this long, as over a slow remote link (0: no delay). */
    get rttMs(): number { return num(env, 'CODE_NOTES_RTT_MS') },
    /** Keep VS Code's profiles here instead of in temp folders. */
    get profile(): string | undefined { return str(env, 'CODE_NOTES_PROFILE') },
    /** Print every workbench console message, not only the errors. */
    get consoleAll(): boolean { return !!env.CODE_NOTES_CONSOLE_ALL },
    /** After a failed test, run the rest anyway (each failure is reported; the run still fails). */
    get keepGoing(): boolean { return !!env.CODE_NOTES_KEEP_GOING },
    /** The chapters to run (ONLY, ONLY_PODCAST), undefined for all. */
    get only(): string[] | undefined { return onlyChapters(env) },
    // Set by run.ts or the tests, not by hand:
    /** The workbench's DevTools port. */
    get cdpPort(): string | undefined { return str(env, 'CODE_NOTES_CDP') },
    /** The file the workbench console errors are collected in. */
    get consoleFile(): string | undefined { return str(env, 'CODE_NOTES_CONSOLE') },
    /** A folder with a slow `git` (the check run). */
    get slowGitDir(): string | undefined { return str(env, 'CODE_NOTES_SLOW_GIT') },
    /** The fake claude CLI's log of its runs (set when a suite wires the fake up). */
    get fakeClaudeLog(): string | undefined { return str(env, 'FAKE_CLAUDE_LOG') },
  }
}

/** The harness's variables, read from process.env. */
export const testEnv = readTestEnv()

/** What `run.js --help` prints. */
export const ENV_HELP = `node out/test/integration/run.js [suite …]   (suites: ${SUITE_NAMES.join(', ')}; all when none is named)
  SUITES=main,check              the suites to run (as on the command line; ONLY_MAIN=1 etc. still work and add up)
  ONLY=notes,podcast             in a suite, only these chapters (each chapter sets up what it needs; see suite.ts)
  ONLY_PODCAST=1 | editor        ONLY=podcast,listenEditor | ONLY=listenEditor
  CODE_NOTES_KEEP_GOING=1        run the tests after a failure too (later ones may fail because of the first)
  CODE_NOTES_TIMEOUT_SCALE=n     every wait n times longer (CI=1 alone gives 3)
  CODE_NOTES_SHOTS=<dir>         pictures of the window at named moments
  CODE_NOTES_ANIM_SHOTS=<dir>    pictures of the animation tests' states
  CODE_NOTES_RTT_MS=<ms>         each counted call into the window waits that long, as over a slow remote link
  CODE_NOTES_PROFILE=<dir>       keep VS Code's profiles there instead of in temp folders
  CODE_NOTES_CONSOLE_ALL=1       print every workbench console message, not only the errors`
