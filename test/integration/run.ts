// Starts a real VS Code with the extension for each integration suite: node out/test/integration/run.js
//   main       suite.ts (main/): notes, journeys, the tour, requests        ONLY_MAIN=1 runs it alone
//   untrusted  untrusted.ts: the same extension in Restricted Mode          ONLY_UNTRUSTED=1
//   check      check/index.ts: the understanding check in a git repository  ONLY_CHECK=1
// With none of the ONLY_* variables set, all three run in turn. The other variables: helpers.ts's header.
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFileSync, spawn } from 'child_process'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import { connectCdp } from './connectCdp'
import { writeSkillStandIn } from './fixtures'
import { writeSlowGit } from '../slowGit'

// The CI job's own variables (GITHUB_HEAD_REF, CI_COMMIT_REF_NAME, …) must not reach VS Code: the extension host
// passes its environment to the understanding CLI, which takes the branch from them. CI itself stays (helpers.ts: SCALE).
for (const k of Object.keys(process.env)) if (/^(GITHUB_|GITLAB_|CI_|RUNNER_)/.test(k)) delete process.env[k]

/** The extension's folder (out/test/integration/ is three below it). */
const ROOT = path.resolve(__dirname, '../../..')

/**
 * What every run starts VS Code with: the workspace `ws`, no other extensions, no Chromium sandbox (CI runners and
 * containers often can't set it up) and its own profile in `userData`.
 */
function baseLaunchArgs(ws: string, userData: string): string[] {
  return [ws, '--disable-extensions', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${userData}`]
}

/** A profile folder for the run `name`: under CODE_NOTES_PROFILE (kept) when set, else a new temp folder. */
function profileDir(name: string, ws: string): string {
  const kept = process.env.CODE_NOTES_PROFILE
  return kept ? path.join(kept, `${name}-${path.basename(ws)}`) : fs.mkdtempSync(path.join(os.tmpdir(), `code-notes-${name}-ud-`))
}

/** The test window is VS Code's default 1024 px (xvfb has no window manager to maximize it), which leaves the editor
 *  ~620 px: zoomed out, the code keeps its 80 characters beside the journey panel, as on a normal screen. */
function roomyEditor(userData: string): string {
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true })
  const f = path.join(userData, 'User', 'settings.json')
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ 'window.zoomLevel': -2 }))
  return userData
}

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

// The main suite: an empty-ish workspace (src/app.ts).
async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-ws-'))
  fs.mkdirSync(path.join(ws, 'src'))
  const appTs = ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}', '']
  fs.writeFileSync(path.join(ws, 'src', 'app.ts'), appTs.join('\n'))
  const userData = roomyEditor(profileDir('main', ws))
  // The DevTools port: the podcast's first Play needs a real click in the journey panel (main/podcast.ts).
  const port = 9300 + Math.floor(Math.random() * 500)
  await runTests({
    extensionDevelopmentPath: ROOT,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [...baseLaunchArgs(ws, userData), '--disable-workspace-trust', `--remote-debugging-port=${port}`],
    extensionTestsEnv: { CODE_NOTES_CDP: String(port) },
  })
  const tree = treeErrors(userData)
  if (tree.length) throw new Error(`tree view errors in the extension host log:\n${tree.join('\n')}`)
  console.log('  ✓ extension host log: no tree view errors')
}

// The same extension in Restricted Mode (workspace trust on, the folder never trusted): Claude never runs.
async function untrusted() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-untrusted-'))
  fs.mkdirSync(path.join(ws, 'src'))
  fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export function main() {\n  return 0\n}\n')
  fs.mkdirSync(path.join(ws, '.vscode'))
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'codeNotes.claude.path': path.join(ws, 'evil.sh') }))
  writeSkillStandIn(ws)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-ud-'))
  fs.mkdirSync(path.join(userData, 'User'))
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'codeNotes.claude.path': path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
  }))
  // runTests always adds --disable-workspace-trust: VS Code is started here without it.
  const exe = await downloadAndUnzipVSCode()
  const args = [
    ...baseLaunchArgs(ws, userData),
    '--disable-updates', '--skip-release-notes', '--no-cached-data',
    `--extensions-dir=${path.join(userData, 'extensions')}`,
    `--extensionTestsPath=${path.join(__dirname, 'untrusted.js')}`,
    `--extensionDevelopmentPath=${ROOT}`,
  ]
  const env = { ...process.env, FAKE_CLAUDE_LOG: path.join(ws, '..', `fake-claude-untrusted-${path.basename(ws)}.log`) }
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(exe, args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('close', (c) => resolve(c))
  })
  if (code !== 0) throw new Error(`Restricted Mode test run failed with code ${code}`)
}

// The understanding check: a git repository (the example shop) on a branch with a change.
async function check() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-check-'))
  fs.cpSync(path.join(ROOT, 'examples', 'shop'), ws, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, env })
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Ada')
  g('config', 'user.email', 'ada@example.com')
  g('add', '-A')
  g('commit', '-qm', 'shop')
  // The change the check asks about: order limits, on feat/limits.
  g('checkout', '-qb', 'feat/limits')
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'check', 'limits.js'), path.join(ws, 'api', 'limits.js'))
  g('add', '-A')
  g('commit', '-qm', 'limits')
  // The test's own workspace settings are not part of the change.
  fs.appendFileSync(path.join(ws, '.git', 'info', 'exclude'), '.vscode/\n')
  // A bare remote: Commit & push has somewhere to push to.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-check-remote-'))
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
  g('remote', 'add', 'origin', remote)
  const userData = profileDir('check', ws)
  // The workbench's own console (Trusted Types errors and the like live there, not in the extension host): read over
  // the DevTools protocol while the suite runs; screenshots of the whole window come from the same connection.
  const port = 9300 + Math.floor(Math.random() * 500)
  const consoleLog = path.join(userData, '..', `workbench-console-${path.basename(ws)}.json`)
  const watcher = watchWorkbench(port, consoleLog)
  try {
    await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'check', 'index.js'),
      launchArgs: [...baseLaunchArgs(ws, roomyEditor(userData)), '--disable-workspace-trust', `--remote-debugging-port=${port}`],
      extensionTestsEnv: {
        CODE_NOTES_SHOTS: process.env.CODE_NOTES_SHOTS ?? '',
        CODE_NOTES_CDP: String(port),
        CODE_NOTES_CONSOLE: consoleLog,
        CODE_NOTES_SLOW_GIT: slowGit(userData),
      },
    })
  } finally { watcher.stop() }
  const errors = (JSON.parse(fs.readFileSync(consoleLog, 'utf8')) as string[]).filter((e) => /TrustedHTML|TrustedScript|code-notes|codeNotes/i.test(e))
  if (errors.length) throw new Error(`workbench console errors:\n${errors.join('\n')}`)
  console.log('  ✓ workbench console: no Trusted Types or Code Notes errors')
}

/**
 * A folder with a `git` that takes 0.25 s a call while the repository it runs in has .git/slow-git (the suite puts it
 * first on PATH for a moment, to see that the extension host never waits for git). Not PATH itself: VS Code may take
 * PATH from the login shell.
 */
function slowGit(dir: string): string {
  const bin = path.join(dir, '..', `slow-git-${path.basename(dir)}`)
  fs.mkdirSync(bin, { recursive: true })
  writeSlowGit(bin, 0.25, '.git/slow-git')
  return bin
}

/** Collects the workbench window's console errors (and page errors) into `file` until stopped. */
function watchWorkbench(port: number, file: string): { stop: () => void } {
  const errors: string[] = []
  const write = () => fs.writeFileSync(file, JSON.stringify(errors, null, 1))
  write()
  let stopped = false
  let browser: import('playwright').Browser | undefined
  const onConsole = (m: import('playwright').ConsoleMessage) => {
    if (process.env.CODE_NOTES_CONSOLE_ALL) console.log(`  [console ${m.type()}] ${m.text().slice(0, 300)}`)
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
    browser = await connectCdp(port, 300, () => stopped).catch(() => undefined)
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

/** The runs ONLY_* asks for (see the header), or all three in turn. */
function selectedRuns(): Promise<void> {
  if (process.env.ONLY_UNTRUSTED) return untrusted()
  if (process.env.ONLY_CHECK) return check()
  if (process.env.ONLY_MAIN) return main()
  return main().then(untrusted).then(check)
}

selectedRuns().catch((e) => { console.error(e); process.exit(1) })
