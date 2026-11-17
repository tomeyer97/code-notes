// Runs inside a real VS Code in Restricted Mode (see run.ts, untrusted()): Claude never runs, reading stays available.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import type { TestApi } from '../../src/testApi'
import { activate, claudeRuns, quiet, readJsonOr, runTests, test, until } from './helpers'

const ws = vscode.workspace.workspaceFolders![0].uri.fsPath
let api: TestApi

const tests = [
  test('Restricted Mode: the folder\'s claude.path is ignored', async () => {
    assert.equal(vscode.workspace.isTrusted, false, 'the folder is not trusted')
    // The folder's own settings can't pick the program Code Notes runs (restrictedConfigurations).
    assert.ok(!/evil/.test(vscode.workspace.getConfiguration('codeNotes').get<string>('claude.path') ?? ''), 'a folder setting for claude.path is ignored')
  }),

  test('notes work; Ask Claude does not run Claude', async () => {
    // A note can still be written and read; Ask Claude runs nothing.
    const file = vscode.Uri.file(path.join(ws, 'src', 'app.ts'))
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file))
    await vscode.commands.executeCommand('codeNotes.createFromThread', { thread: { uri: file, range: new vscode.Range(1, 0, 1, 0), dispose() {} }, text: 'Why?' })
    const note = await until('note created', () => api.snapshot().notes[0])
    await vscode.commands.executeCommand('codeNotes.askClaude', note.id)
    await quiet(1500, 'Claude starting for the note')
    assert.equal(api.snapshot().notes[0].asking, false)
    assert.equal(claudeRuns().length, 0, 'no claude run for a note')
  }),

  test('writing a journey (command or request file) does not run Claude; the script is told "untrusted"', async () => {
    assert.equal(await api.writeJourney('How is a note saved?'), undefined)
    assert.equal(claudeRuns().length, 0, 'no claude run for a journey')
    // The script's request: "untrusted" back, nothing runs.
    const request = path.join(ws, '.code-notes', '.request.json')
    fs.writeFileSync(request, JSON.stringify({ action: 'ask', question: 'How are widgets frobnicated?', at: new Date().toISOString(), id: 'u-1' }))
    const resultFile = path.join(ws, '.code-notes', '.result.json')
    await until('result', () => readJsonOr(resultFile)?.id === 'u-1', 8000)
    assert.equal(readJsonOr(resultFile).outcome, 'untrusted')
    await quiet(1000, 'Claude starting for the request')
    assert.equal(claudeRuns().length, 0, 'no claude run for a request')
    assert.ok(api.explainLog().some((x: any) => x.outcome === 'untrusted'))
  }),
]

export async function run(): Promise<void> {
  console.log('code-notes integration test (Restricted Mode)')
  api = await activate()
  await runTests(tests)
  console.log('all passed')
}
