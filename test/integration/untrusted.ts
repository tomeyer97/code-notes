// Runs inside a real VS Code in Restricted Mode (see run.ts, the untrusted suite): Claude never runs, reading stays
// available.
import * as vscode from 'vscode'
import * as path from 'path'
import assert from 'assert'
import { Chapter, SuiteContext, claudeRuns, createSuiteContext, quiet, runChapters, test } from './helpers'
import { readResult, writeRequest } from './fixtures'

/**
 * How long Claude would take to start if it were allowed to (× SCALE): the extension starts a run at once, and the
 * fake CLI logs its run as its first act. The note's check has no affirmative signal yet (the extension logs nothing
 * when it skips a run for an untrusted folder), so it waits this long for an absence.
 */
const CLAUDE_START_MS = 1500

/** Set by `run` before the first test. */
let suite: SuiteContext

const tests = [
  test('Restricted Mode: the folder\'s claude.path is ignored', async () => {
    assert.equal(vscode.workspace.isTrusted, false, 'the folder is not trusted')
    // The folder's own settings can't pick the program Code Notes runs (restrictedConfigurations).
    assert.ok(!/evil/.test(vscode.workspace.getConfiguration('codeNotes').get<string>('claude.path') ?? ''), 'a folder setting for claude.path is ignored')
  }),

  test('notes work; Ask Claude does not run Claude', async () => {
    const { api, ws, until } = suite
    // A note can still be written and read; Ask Claude runs nothing.
    const file = vscode.Uri.file(path.join(ws, 'src', 'app.ts'))
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file))
    await vscode.commands.executeCommand('codeNotes.createFromThread', { thread: { uri: file, range: new vscode.Range(1, 0, 1, 0), dispose() {} }, text: 'Why?' })
    const note = await until('note created', () => api.snapshot().notes[0])
    await vscode.commands.executeCommand('codeNotes.askClaude', note.id)
    await quiet(CLAUDE_START_MS, 'Claude starting for the note')
    assert.equal(api.snapshot().notes[0].asking, false)
    assert.equal(claudeRuns().length, 0, 'no claude run for a note')
  }),

  test('writing a journey (command or request file) does not run Claude; the script is told "untrusted"', async () => {
    const { api, notesDir, until } = suite
    assert.equal(await api.writeJourney('How is a note saved?'), undefined)
    assert.equal(claudeRuns().length, 0, 'no claude run for a journey')
    // The script's request: "untrusted" back, and the extension's own log says it skipped the run for that reason.
    writeRequest(notesDir, { action: 'ask', question: 'How are widgets frobnicated?', id: 'u-1' })
    await until('result', () => readResult(notesDir)?.id === 'u-1', 8000)
    assert.equal(readResult(notesDir).outcome, 'untrusted')
    await until('the request logged as skipped: untrusted', () => api.explainLog().some((x: any) => x.outcome === 'untrusted'))
    // Belt and braces: still no run a moment later.
    await quiet(1000, 'Claude starting for the request')
    assert.equal(claudeRuns().length, 0, 'no claude run for a request')
  }),
]

/** The suite as one chapter (run.ts's untrusted suite). */
export const chapters: Chapter[] = [{ name: 'untrusted', file: 'untrusted.ts', tests, covers: 'Restricted Mode: Claude never runs, reading stays available' }]

/** The entry point run.ts starts VS Code with (extensionTestsPath). */
export async function run(): Promise<void> {
  suite = await createSuiteContext()
  await runChapters('code-notes integration test (Restricted Mode)', chapters, { scenario: true })
  console.log('all passed')
}
