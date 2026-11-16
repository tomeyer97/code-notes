// Starts a real VS Code with the extension and runs suite.ts in it: node out/test/integration/run.js
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFileSync, spawn } from 'child_process'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-ws-'))
  fs.mkdirSync(path.join(ws, 'src'))
  fs.writeFileSync(path.join(ws, 'src', 'app.ts'), ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}', ''].join('\n'))
  const root = path.resolve(__dirname, '../../..')
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'index.js'),
    // No Chromium sandbox: CI runners (and containers) often can't set it up; the untrusted run below does the same.
    launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox',
      ...(process.env.CODE_NOTES_PROFILE ? [`--user-data-dir=${path.join(process.env.CODE_NOTES_PROFILE, `main-${path.basename(ws)}`)}`] : [])],
  })
}

// The same extension in Restricted Mode (workspace trust on, the folder never trusted): Claude never runs.
async function untrusted() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-untrusted-'))
  fs.mkdirSync(path.join(ws, 'src'))
  fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export function main() {\n  return 0\n}\n')
  fs.mkdirSync(path.join(ws, '.vscode'))
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'codeNotes.claude.path': path.join(ws, 'evil.sh') }))
  fs.mkdirSync(path.join(ws, '.claude', 'skills', 'code-journey', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.claude', 'skills', 'code-journey', 'scripts', 'journey.py'), '# stand-in\n')
  const root = path.resolve(__dirname, '../../..')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-ud-'))
  fs.mkdirSync(path.join(userData, 'User'))
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never',
    'codeNotes.claude.path': path.join(root, 'test', 'fixtures', 'fake-claude.js'),
  }))
  // runTests always adds --disable-workspace-trust: VS Code is started here without it.
  const exe = await downloadAndUnzipVSCode()
  const args = [ws, '--disable-extensions', '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--no-cached-data',
    `--user-data-dir=${userData}`, `--extensions-dir=${path.join(userData, 'extensions')}`,
    `--extensionTestsPath=${path.join(__dirname, 'index-untrusted.js')}`, `--extensionDevelopmentPath=${root}`]
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
  const root = path.resolve(__dirname, '../../..')
  fs.cpSync(path.join(root, 'examples', 'shop'), ws, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, env })
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Ada'); g('config', 'user.email', 'ada@example.com')
  g('add', '-A'); g('commit', '-qm', 'shop')
  g('checkout', '-qb', 'feat/limits')
  fs.writeFileSync(path.join(ws, 'api', 'limits.js'), ['// Orders per customer per hour.', 'const counts = new Map()', '',
    'export function allow(customer, now = Date.now()) {', '  const c = counts.get(customer)', '  if (!c || now - c.since > 3600_000) { counts.set(customer, { since: now, n: 1 }); return true }',
    '  return ++c.n <= 5', '}', '', '// One count per customer: a customer splitting a big cart into orders is still one customer.',
    'export function reset(customer) {', '  counts.delete(customer)', '}', ...Array.from({ length: 52 }, (_, i) => `export const LIMIT_${i} = ${i}`), ''].join('\n'))
  g('add', '-A'); g('commit', '-qm', 'limits')
  // The test's own workspace settings are not part of the change.
  fs.appendFileSync(path.join(ws, '.git', 'info', 'exclude'), '.vscode/\n')
  // A bare remote: Commit & push has somewhere to push to.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-check-remote-'))
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
  g('remote', 'add', 'origin', remote)
  const userData = process.env.CODE_NOTES_PROFILE ? path.join(process.env.CODE_NOTES_PROFILE, `check-${path.basename(ws)}`) : fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-check-ud-'))
  // The workbench's own console (Trusted Types errors and the like live there, not in the extension host): read over
  // the DevTools protocol while the suite runs; screenshots of the whole window come from the same connection.
  const port = 9300 + Math.floor(Math.random() * 500)
  const consoleLog = path.join(userData, '..', `workbench-console-${path.basename(ws)}.json`)
  const watcher = watchWorkbench(port, consoleLog)
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'index-check.js'),
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
      extensionTestsEnv: { CODE_NOTES_SHOTS: process.env.CODE_NOTES_SHOTS ?? '', CODE_NOTES_CDP: String(port), CODE_NOTES_CONSOLE: consoleLog },
    })
  } finally { watcher.stop() }
  const errors = (JSON.parse(fs.readFileSync(consoleLog, 'utf8')) as string[]).filter((e) => /TrustedHTML|TrustedScript|code-notes|codeNotes/i.test(e))
  if (errors.length) throw new Error(`workbench console errors:\n${errors.join('\n')}`)
  console.log('  ✓ workbench console: no Trusted Types or Code Notes errors')
}

/** Collects the workbench window's console errors (and page errors) into `file` until stopped. */
function watchWorkbench(port: number, file: string): { stop: () => void } {
  const errors: string[] = []
  const write = () => fs.writeFileSync(file, JSON.stringify(errors, null, 1))
  write()
  let stopped = false
  let browser: { close(): Promise<void> } | undefined
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright')
    for (let i = 0; i < 300 && !stopped && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await new Promise((r) => setTimeout(r, 200)) }
    }
    if (!browser) { console.log(`  ! no DevTools connection on port ${port}: the workbench console is not checked`); return }
    const b = browser as unknown as import('playwright').Browser
    console.log(`  (workbench console: watching ${b.contexts().reduce((n, c) => n + c.pages().length, 0)} page(s))`)
    const hook = (page: import('playwright').Page) => {
      page.on('console', (m) => { if (process.env.CODE_NOTES_CONSOLE_ALL) console.log(`  [console ${m.type()}] ${m.text().slice(0, 300)}`); if (m.type() === 'error') { errors.push(`${m.text()}${m.location()?.url ? ` (${m.location().url}:${m.location().lineNumber})` : ''}`); write() } })
      page.on('pageerror', (e) => { errors.push(`${e.message}\n${e.stack ?? ''}`); write() })
    }
    for (const c of b.contexts()) { c.pages().forEach(hook); c.on('page', hook) }
  })()
  return { stop: () => { stopped = true; void browser?.close().catch(() => {}) } }
}

const only = process.env.ONLY_UNTRUSTED ? untrusted() : process.env.ONLY_CHECK ? check() : process.env.ONLY_MAIN ? main() : main().then(untrusted).then(check)
only.catch((e) => { console.error(e); process.exit(1) })
