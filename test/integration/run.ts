// Starts a real VS Code with the extension for each integration suite: node out/test/integration/run.js [suite …]
// (`--help` lists the suites and the environment variables, support/testEnv.ts). Every suite is started by the same
// `launch`: its own workspace (fixtures.ts), its own profile, a free DevTools port, the CI job's variables left out,
// the workbench console watched and the extension host's log read for tree view errors afterwards.
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { spawn } from 'child_process'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import { connectCdp } from './connectCdp'
import { REPO_ROOT, fixturePath, makeCheckRepo, makeMainWorkspace, makeUntrustedWorkspace } from './fixtures'
import { writeSlowGit, SLOW_GIT_MARKER } from '../helpers/slowGit'
import { freePort } from './support/freePort'
import { ENV_HELP, SuiteName, selectedSuites, testEnv } from './support/testEnv'

/** The extension's folder. */
const ROOT = REPO_ROOT

/** How many times (0.2 s apart) the console watcher tries to reach the workbench while VS Code starts: a minute. */
const CDP_TRIES = 300

type Env = Record<string, string | undefined>

/**
 * The environment VS Code runs with: ours, without the CI job's own variables (GITHUB_HEAD_REF, CI_COMMIT_REF_NAME,
 * …: the extension host passes its environment to the understanding CLI, which takes the branch from them) and without
 * a sound server (the tests play audio, never out loud: WSLg routes PulseAudio to the host; VS Code's Chromium is muted
 * too, --mute-audio). CI itself stays (the waits scale with it). Each left-out variable is `undefined`, which removes
 * it whether the launcher merges this over process.env (runTests) or uses it as is.
 */
function vscodeEnv(extra: Env): Env {
  const out: Env = {}
  for (const k of Object.keys(process.env)) out[k] = /^(GITHUB_|GITLAB_|CI_|RUNNER_)/.test(k) || k === 'PULSE_SERVER' ? undefined : process.env[k]
  return { ...out, ...extra }
}

/**
 * What every run starts VS Code with: the workspace `ws`, no other extensions, no Chromium sandbox (CI runners and
 * containers often can't set it up) and its own profile in `userData`.
 */
function baseLaunchArgs(ws: string, userData: string): string[] {
  return [ws, '--disable-extensions', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox', '--mute-audio', `--user-data-dir=${userData}`]
}

/** A profile folder for the run `name`: under CODE_NOTES_PROFILE (kept) when set, else a new temp folder. */
function profileDir(name: string, ws: string): string {
  const kept = testEnv.profile
  return kept ? path.join(kept, `${name}-${path.basename(ws)}`) : fs.mkdtempSync(path.join(os.tmpdir(), `code-notes-${name}-ud-`))
}

/** The profile's settings.json, unless it has one already (a kept profile keeps its own). */
function userSettings(userData: string, settings: object, { overwrite = false } = {}): void {
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true })
  const f = path.join(userData, 'User', 'settings.json')
  if (overwrite || !fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(settings))
}

/** The test window is VS Code's default 1024 px (xvfb has no window manager to maximize it), which leaves the editor
 *  ~620 px: zoomed out, the code keeps its 80 characters beside the journey panel, as on a normal screen. */
const ROOMY_EDITOR = { 'window.zoomLevel': -2 }

/** Errors VS Code logged about the extension's tree views (a node revealed or expanded after it was redrawn away). */
function treeErrors(userData: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'exthost.log') out.push(...fs.readFileSync(p, 'utf8').split('\n').filter((l) => /TreeView:codeNotes|resolve tree item .*code-notes/.test(l)))
    }
  }
  walk(path.join(userData, 'logs'))
  return out
}

/**
 * A folder with a `git` that takes 0.25 s a call while the repository it runs in has SLOW_GIT_MARKER (the suite puts
 * it first on PATH for a moment, to see that the extension host never waits for git). Not PATH itself: VS Code may
 * take PATH from the login shell.
 */
function slowGit(dir: string): string {
  const bin = path.join(dir, '..', `slow-git-${path.basename(dir)}`)
  fs.mkdirSync(bin, { recursive: true })
  writeSlowGit(bin, 0.25, SLOW_GIT_MARKER)
  return bin
}

/** One suite: where its tests are, how its workspace and profile are made, and which safety nets fail it. */
interface Suite {
  name: SuiteName
  covers: string
  /** The compiled entry point (extensionTestsPath), relative to this folder. */
  tests: string
  workspace: () => string
  /** The profile's settings; `overwrite`: even in a kept profile. */
  settings: object
  overwriteSettings?: boolean
  /** Restricted Mode: VS Code is started without --disable-workspace-trust (which runTests always adds). */
  untrusted?: boolean
  /** Variables for the tests, beside the DevTools port and the console file every suite gets. */
  env?: (ws: string, userData: string) => Env
  /**
   * Which of the safety nets every run applies fail this suite (the others are printed only): tree view errors in the
   * extension host's log, Trusted Types and Code Notes errors in the workbench console.
   */
  failOn: { treeErrors: boolean; consoleErrors: boolean }
}

/** The suites, in the order they run when none is picked. */
const SUITES: Suite[] = [
  {
    name: 'main', covers: 'suite.ts (main/): notes, journeys, the tour, requests', tests: 'suite.js',
    workspace: makeMainWorkspace, settings: ROOMY_EDITOR,
    failOn: { treeErrors: true, consoleErrors: false },
  },
  {
    name: 'untrusted', covers: 'untrusted.ts: the same extension in Restricted Mode (the folder never trusted)', tests: 'untrusted.js',
    workspace: makeUntrustedWorkspace, untrusted: true, overwriteSettings: true,
    settings: {
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
      'security.workspace.trust.banner': 'never',
      'codeNotes.claude.path': fixturePath('fake-claude.js'),
    },
    env: (ws) => ({ FAKE_CLAUDE_LOG: path.join(ws, '..', `fake-claude-untrusted-${path.basename(ws)}.log`) }),
    failOn: { treeErrors: false, consoleErrors: false },
  },
  {
    name: 'check', covers: 'check/index.ts: the understanding check in a git repository', tests: 'check/index.js',
    workspace: makeCheckRepo, settings: ROOMY_EDITOR,
    env: (_ws, userData) => ({ CODE_NOTES_SHOTS: testEnv.shots ?? '', CODE_NOTES_SLOW_GIT: slowGit(userData) }),
    failOn: { treeErrors: false, consoleErrors: true },
  },
]

/** Starts VS Code in Restricted Mode: runTests can't (it always adds --disable-workspace-trust). */
async function runUntrusted(args: { ws: string; userData: string; testsPath: string; extraArgs: string[]; env: Env }): Promise<void> {
  const exe = await downloadAndUnzipVSCode()
  const argv = [
    ...baseLaunchArgs(args.ws, args.userData), ...args.extraArgs,
    '--disable-updates', '--skip-release-notes', '--no-cached-data',
    `--extensions-dir=${path.join(args.userData, 'extensions')}`,
    `--extensionTestsPath=${args.testsPath}`,
    `--extensionDevelopmentPath=${ROOT}`,
  ]
  const env = Object.fromEntries(Object.entries(args.env).filter(([, v]) => v !== undefined))
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(exe, argv, { env, stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('close', (c) => resolve(c))
  })
  if (code !== 0) throw new Error(`Restricted Mode test run failed with code ${code}`)
}

/** A safety net's findings: fail the suite with them, or print them. */
function report(failing: boolean, what: string, found: string[], ok: string): void {
  if (!found.length) { console.log(`  ✓ ${ok}`); return }
  const text = `${what}:\n${found.join('\n')}`
  if (failing) throw new Error(text)
  console.log(`  ! (not failing this suite) ${text}`)
}

/** Starts VS Code for `suite` and runs its tests, with every safety net. */
async function launch(suite: Suite): Promise<void> {
  console.log(`\n${suite.name}: ${suite.covers}`)
  const ws = suite.workspace()
  const userData = profileDir(suite.name, ws)
  // A controller running on this machine is never found: the bridge looks in the profile (the bridge chapter writes
  // its own file).
  userSettings(userData, { 'codeNotes.bridge.discovery': path.join(userData, 'bridge.json'), ...suite.settings }, { overwrite: suite.overwriteSettings })
  // The DevTools port: real clicks in webviews (devtools.ts) and the workbench's own console (Trusted Types errors
  // and the like live there, not in the extension host).
  const port = await freePort()
  const consoleLog = path.join(userData, '..', `workbench-console-${path.basename(ws)}.json`)
  const env = vscodeEnv({ CODE_NOTES_CDP: String(port), CODE_NOTES_CONSOLE: consoleLog, ...suite.env?.(ws, userData) })
  const testsPath = path.join(__dirname, suite.tests)
  const watcher = watchWorkbench(port, consoleLog)
  try {
    if (suite.untrusted) await runUntrusted({ ws, userData, testsPath, extraArgs: [`--remote-debugging-port=${port}`], env })
    else {
      await runTests({
        extensionDevelopmentPath: ROOT,
        extensionTestsPath: testsPath,
        launchArgs: [...baseLaunchArgs(ws, userData), '--disable-workspace-trust', `--remote-debugging-port=${port}`],
        extensionTestsEnv: env,
      })
    }
  } finally { watcher.stop() }
  report(suite.failOn.treeErrors, 'tree view errors in the extension host log', treeErrors(userData), 'extension host log: no tree view errors')
  const consoleErrors = (JSON.parse(fs.readFileSync(consoleLog, 'utf8')) as string[]).filter((e) => /TrustedHTML|TrustedScript|code-notes|codeNotes/i.test(e))
  report(suite.failOn.consoleErrors, 'workbench console errors', consoleErrors, 'workbench console: no Trusted Types or Code Notes errors')
}

/** Collects the workbench window's console errors (and page errors) into `file` until stopped. */
function watchWorkbench(port: number, file: string): { stop: () => void } {
  const errors: string[] = []
  const write = () => fs.writeFileSync(file, JSON.stringify(errors, null, 1))
  write()
  let stopped = false
  let browser: import('playwright').Browser | undefined
  const onConsole = (m: import('playwright').ConsoleMessage) => {
    if (testEnv.consoleAll) console.log(`  [console ${m.type()}] ${m.text().slice(0, 300)}`)
    if (m.type() !== 'error') return
    const where = m.location()?.url ? ` (${m.location().url}:${m.location().lineNumber})` : ''
    errors.push(`${m.text()}${where}`)
    write()
  }
  const hook = (page: import('playwright').Page) => {
    page.on('console', onConsole)
    page.on('pageerror', (e) => { errors.push(`${e.message}\n${e.stack ?? ''}`); write() })
    // A blocked Trusted Types assignment logs no stack: the page's own violation event says which script and what HTML.
    const reportViolations = `document.addEventListener('securitypolicyviolation', (e) => console.error('[csp] ' + e.violatedDirective + ' ' + e.sourceFile + ':' + e.lineNumber + ':' + e.columnNumber + ' sample=' + JSON.stringify(e.sample)))`
    void page.evaluate(reportViolations).catch(() => undefined)
  }
  void (async () => {
    browser = await connectCdp(port, CDP_TRIES, () => stopped).catch(() => undefined)
    if (!browser) { console.log(`  ! no DevTools connection on port ${port}: the workbench console is not checked`); return }
    const pages = browser.contexts().reduce((n, c) => n + c.pages().length, 0)
    console.log(`  (workbench console: watching ${pages} page(s))`)
    for (const c of browser.contexts()) {
      c.pages().forEach(hook)
      c.on('page', hook)
    }
  })()
  return { stop: () => { stopped = true; void browser?.close().catch(() => {}) } }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`${ENV_HELP}\n\nThe suites:\n${SUITES.map((s) => `  ${s.name.padEnd(10)} ${s.covers}`).join('\n')}`)
    return
  }
  const picked = selectedSuites(process.env, argv)
  for (const s of SUITES.filter((x) => picked.includes(x.name))) await launch(s)
}

main().catch((e) => { console.error(e); process.exit(1) })
