// Runs inside a real VS Code (see run.ts, checkRun): the understanding check end to end with a fake Claude
// (test/fixtures/fake-grader.js): questions written with the skill's script, answered in their threads, graded,
// the file updated, the threshold met, the file staged. The workspace is a git repository on a branch with a change.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import assert from 'assert'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SCALE = Number(process.env.CODE_NOTES_TIMEOUT_SCALE) || (process.env.CI ? 3 : 1)
async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms * SCALE) { console.log('state:', JSON.stringify(dump?.(), null, 1)?.slice(0, 3000)); throw new Error(`timed out waiting for: ${what}`) }
    await sleep(100)
  }
}
let dump: (() => unknown) | undefined
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath
  const api = (await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`)!.activate()) as any
  const ok = (m: string) => console.log(`  ✓ ${m}`)
  const chk = () => api.check()
  const file = path.join(ws, 'understanding/feat-limits.json')
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  const checkNotes = () => (api.snapshot().notes as any[]).filter((n) => n.session === 'Check · feat/limits')
  const noteOf = (q: string) => checkNotes().find((n) => n.extra?.check?.q === q)
  dump = () => ({ check: chk(), files: fs.readdirSync(ws), u: fs.existsSync(path.join(ws, 'understanding')) && fs.readdirSync(path.join(ws, 'understanding')), notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]) })
  const shot = (name: string) => { const d = process.env.CODE_NOTES_SHOTS; if (d) execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)]) }

  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)

  // 1. A branch with a change and no check: the status bar offers one.
  await until('status bar offers a check', () => chk()?.item === '$(checklist) Check')
  ok('the status bar offers "Check" on a branch with a change')

  // 2. Check my understanding: Claude writes the questions with the skill; threads and the panel open.
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('three question threads', () => checkNotes().length === 3)
  const c0 = read()
  assert.deepEqual(c0.questions.map((q: any) => q.kind), ['failure', 'why', 'edge'])
  assert.equal(c0.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim())
  assert.ok(c0.answeredBy?.name, 'who answers, from git')
  const n1 = noteOf('q1')
  assert.deepEqual([n1.file, n1.range.start, n1.range.end], ['api/limits.js', 4, 7])
  assert.match(n1.messages[0].body, /^What does allow\(\) do/)
  assert.equal(noteOf('q3').target, 'file')
  assert.match(api.thread(n1.id).contextValue, /check/)
  await until('panel drawn with three rows', () => chk().panel.rows === 3)
  assert.equal(chk().view.progress, '0 of 3 passed · 2 needed')
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(ws, 'api/limits.js'), 'the first question\'s code opened')
  await sleep(800)
  shot('check-1-questions')
  ok('questions written with the skill: threads on their lines (a file thread for the design one), the panel, the code')

  const answer = async (q: string, text: string) => {
    const n = noteOf(q)
    await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(n.id), text })
  }
  const lastBody = (q: string) => { const m = noteOf(q).messages; return m[m.length - 1].body as string }

  // 3. A good answer: ✓ in the thread, the verdict and its hash in the file, the thread resolved.
  await answer('q1', 'GOOD: the window starts over, so the count goes back to one.')
  await until('q1 passed in the thread', () => lastBody('q1').startsWith('✓ '))
  const a1 = read().questions[0].attempts[0]
  assert.equal(a1.verdict, 'pass'); assert.match(a1.hash, /^[0-9a-f]{12}$/); assert.match(a1.answer, /^GOOD/)
  await until('q1 resolved', () => noteOf('q1').status === 'resolved')
  assert.deepEqual(noteOf('q1').messages.map((m: any) => m.role), ['agent', 'human', 'agent'])
  ok('a good answer: a short confirmation in the thread, the verdict and hash in the file, the thread resolved')

  // 4. A miss gets feedback and a hint; the second miss the explanation.
  // A row in the panel opens its question's thread on its lines.
  api.checkPanelSend({ type: 'test', click: 'button.open[data-id="q2"]' })
  await until('q2 opened from the panel', () => api.snapshot().notes.find((n: any) => n.id === noteOf('q2').id)?.threadExpanded && vscode.window.activeTextEditor?.selection.active.line === 9)
  await answer('q2', 'Not sure.')
  await until('q2: try again with a hint', () => /^Not quite[\s\S]*\*\*Hint:\*\*/.test(lastBody('q2')))
  assert.equal(chk().view.rows[1].word, 'try again')
  await sleep(500)
  shot('check-2-hint')
  await answer('q2', 'Still not sure.')
  await until('q2 explained', () => /Counted as missed/.test(lastBody('q2')))
  assert.deepEqual(read().questions[1].attempts.map((a: any) => a.verdict), ['retry', 'explained'])
  ok('a miss: feedback and a hint; the second miss: the explanation, counted as missed')

  // 5. The threshold: the panel's one next step, the status bar, Stage it.
  await answer('q3', 'GOOD: they are in memory, so a restart forgets them.')
  await until('met', () => chk().view?.met && chk().view.next?.action === 'stage')
  assert.equal(chk().view.progress, 'Passed · 2 of 3')
  assert.equal(chk().view.next.text, 'Commit understanding/feat-limits.json and push.')
  await until('status bar passed', () => chk().item === '$(pass) 2/3 ✓')
  await sleep(500)
  shot('check-3-passed')
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  await until('staged', () => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ws, encoding: 'utf8' }).includes('understanding/feat-limits.json'))
  await until('panel says staged', () => chk().view.next?.text === 'Staged. Commit and push.')
  ok('threshold met: "Commit … and push" with Stage it, which stages the file; the status bar shows 2/3 ✓')

  // 6. The CLI agrees (no model): the committed file passes `ci`.
  execFileSync('git', ['commit', '-qm', 'understanding check'], { cwd: ws })
  const out = execFileSync('node', [path.join(__dirname, '../../../cli/understanding.mjs'), 'ci', '--base', 'main'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.match(out, /^✓ Understanding check passed: 2 of 3 \(2 needed\)/)
  ok('`ci` passes the committed file without calling a model')

  // 7. The panel never showed an error or anything wider than itself.
  const p = chk().panel
  assert.deepEqual(p.errors, []); assert.deepEqual(p.overflow, [])
  ok('panel: no errors, nothing cut or sticking out')
}
