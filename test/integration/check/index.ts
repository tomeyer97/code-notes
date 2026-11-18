// The understanding check end to end, inside a real VS Code (run.ts, check()) with a fake Claude
// (test/fixtures/fake-grader.js): questions written with the skill's script, answered in their threads, graded, the
// file updated, the threshold met, the file staged. The workspace is a git repository (examples/shop) on a branch with
// a change. One test per behaviour, in order: each starts where the previous one left the repository and the window.
// Tests marked `devtools` type and click for real in the workbench page (../devtools.ts) and are skipped without it.
//
// The chapters, in the order they run:
//   start.ts         no check yet, Start, question 1 open, the view at 1280×800
//   answers.ts       a good answer, a miss and its hint, the answer box, explained, the grader's concern
//   commitPush.ts    Commit & push, `ci`
//   askAndFix.ts     Ask Claude on a question, Suggest a fix, a concern dismissed
//   branches.ts      drift, other branches, a branch switch while writing, another git user
//   checkFile.ts     the check file rewritten, conflicted, broken, merged
//   tour.ts          questions written in the background, the tour of the change
//   journeysView.ts  the Journeys view (a guest: this workspace has a journey in the repository)
//   refresh.ts       the view's errors, refreshes, calls into the window, a double Ctrl+Enter
// Helpers and the state the chapters share: context.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { runTests } from '../helpers'
import { activateCheck, api, chk, setDumpState, ws } from './context'
import { startTests } from './start'
import { answersTests } from './answers'
import { commitPushTests } from './commitPush'
import { askAndFixTests } from './askAndFix'
import { branchesTests } from './branches'
import { checkFileTests } from './checkFile'
import { tourTests } from './tour'
import { journeysViewTests } from './journeysView'
import { refreshTests } from './refresh'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The entry point run.ts starts VS Code with (extensionTestsPath): the setup every chapter depends on, then the tests. */
export async function run(): Promise<void> {
  console.log('code-notes understanding check')
  await activateCheck()
  const understandingDir = path.join(ws, 'understanding')
  setDumpState(() => ({
    notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]),
    u: fs.existsSync(understandingDir) && fs.readdirSync(understandingDir),
    files: fs.readdirSync(ws),
    check: chk(),
  }))
  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)
  // No tour until the tour tests (the fake Claude gives up on it): the tests before are about the questions alone.
  fs.writeFileSync(path.join(ws, '.git', 'fake-no-tour'), '')
  await runTests([
    ...startTests,
    ...answersTests,
    ...commitPushTests,
    ...askAndFixTests,
    ...branchesTests,
    ...checkFileTests,
    ...tourTests,
    ...journeysViewTests,
    ...refreshTests,
  ])
  console.log('all passed')
}
