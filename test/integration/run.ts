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
    launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox'],
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
    'export function reset(customer) {', '  counts.delete(customer)', '}', ...Array.from({ length: 14 }, (_, i) => `export const LIMIT_${i} = ${i}`), ''].join('\n'))
  g('add', '-A'); g('commit', '-qm', 'limits')
  const userData = process.env.CODE_NOTES_PROFILE ? path.join(process.env.CODE_NOTES_PROFILE, `check-${path.basename(ws)}`) : fs.mkdtempSync(path.join(os.tmpdir(), 'code-notes-check-ud-'))
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'index-check.js'),
    launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${userData}`],
    extensionTestsEnv: { CODE_NOTES_SHOTS: process.env.CODE_NOTES_SHOTS ?? '' },
  })
}

const only = process.env.ONLY_UNTRUSTED ? untrusted() : process.env.ONLY_CHECK ? check() : process.env.ONLY_MAIN ? main() : main().then(untrusted).then(check)
only.catch((e) => { console.error(e); process.exit(1) })
