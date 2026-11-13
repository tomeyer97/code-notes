// Runs inside a real VS Code in Restricted Mode (see run.ts): Claude never runs, reading stays available.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits are tuned for a fast machine; CI (or CODE_NOTES_TIMEOUT_SCALE=n) gives every wait n times longer. */
const SCALE = Number(process.env.CODE_NOTES_TIMEOUT_SCALE) || (process.env.CI ? 3 : 1)
async function until<T>(what: string, fn: () => T | undefined | false, ms = 6000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms * SCALE) throw new Error(`timed out waiting for: ${what}`)
    await sleep(100)
  }
}

export async function run(): Promise<void> {
  console.log('code-notes integration test (Restricted Mode)')
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath
  const ok = (m: string) => console.log(`  ✓ ${m}`)
  // The extension's id, from package.json (publisher.name).
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
  const api = (await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`)!.activate()) as any
  assert.equal(vscode.workspace.isTrusted, false, 'the folder is not trusted')
  const fakeLog = process.env.FAKE_CLAUDE_LOG!
  const runs = () => { try { return fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter((l) => l.includes('"-p"')).length } catch { return 0 } }
  // The folder's own settings can't pick the program Code Notes runs (restrictedConfigurations).
  assert.ok(!/evil/.test(vscode.workspace.getConfiguration('codeNotes').get<string>('claude.path') ?? ''), 'a folder setting for claude.path is ignored')
  ok('Restricted Mode: the folder\'s claude.path is ignored')

  // A note can still be written and read; Ask Claude runs nothing.
  const file = vscode.Uri.file(path.join(ws, 'src', 'app.ts'))
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file))
  await vscode.commands.executeCommand('codeNotes.createFromThread', { thread: { uri: file, range: new vscode.Range(1, 0, 1, 0), dispose() {} }, text: 'Why?' })
  const n = await until('note created', () => api.snapshot().notes[0])
  await vscode.commands.executeCommand('codeNotes.askClaude', n.id)
  await sleep(1500)
  assert.equal(api.snapshot().notes[0].asking, false)
  assert.equal(runs(), 0, 'no claude run for a note')
  ok('notes work; Ask Claude does not run Claude')

  // Writing a journey: nothing runs.
  assert.equal(await api.writeJourney('How is a note saved?'), undefined)
  assert.equal(runs(), 0, 'no claude run for a journey')
  // The script's request: "untrusted" back, nothing runs.
  const req = path.join(ws, '.code-notes', '.request.json')
  fs.writeFileSync(req, JSON.stringify({ action: 'ask', question: 'How are widgets frobnicated?', at: new Date().toISOString(), id: 'u-1' }))
  const resFile = path.join(ws, '.code-notes', '.result.json')
  await until('result', () => fs.existsSync(resFile) && JSON.parse(fs.readFileSync(resFile, 'utf8')).id === 'u-1', 8000)
  assert.equal(JSON.parse(fs.readFileSync(resFile, 'utf8')).outcome, 'untrusted')
  await sleep(1000)
  assert.equal(runs(), 0, 'no claude run for a request')
  assert.ok(api.explainLog().some((x: any) => x.outcome === 'untrusted'))
  ok('writing a journey (command or request file) does not run Claude; the script is told "untrusted"')
  console.log('all passed')
}
