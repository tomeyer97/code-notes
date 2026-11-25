// The understanding check end to end, inside a real VS Code (run.ts) with a fake Claude (test/fixtures/fake-grader.js,
// driven through fakeGrader.ts): questions written with the skill's script, answered in their threads, graded, the
// file updated, the threshold met, the file staged. The workspace is a git repository (examples/shop) on a branch with
// a change (../fixtures.ts `makeCheckRepo`).
//
// This suite is ONE scenario in phases: `phases` below is the order they run in, and each phase starts where the one
// before left the repository and the window (what a phase hands on by value is `left` in context.ts). So a phase
// can't run alone, and a failure stops the run. Tests marked `devtools` type and click for real in the workbench page
// (../devtools.ts) and are skipped without it. Helpers and the state the phases share: context.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { Chapter, runChapters } from '../helpers'
import { activateCheck, chk, setDumpState } from './context'
import { setFakeScenario } from './fakeGrader'
import { startTests } from './start'
import { answersTests } from './answers'
import { commitPushTests } from './commitPush'
import { askAndFixTests } from './askAndFix'
import { branchesTests } from './branches'
import { checkFileTests } from './checkFile'
import { tourTests } from './tour'
import { journeysViewTests } from './journeysView'
import { refreshTests } from './refresh'

/** The scenario's phases, in the order they run. */
export const phases: Chapter[] = [
  { name: 'start', file: 'check/start.ts', tests: startTests, covers: 'no check yet, Start, question 1 open, the view at 1280×800' },
  { name: 'answers', file: 'check/answers.ts', tests: answersTests, covers: 'a good answer, a miss and its hint, the answer box, explained, the grader\'s concern' },
  { name: 'commitPush', file: 'check/commitPush.ts', tests: commitPushTests, covers: 'Commit & push, `ci`' },
  { name: 'askAndFix', file: 'check/askAndFix.ts', tests: askAndFixTests, covers: 'Ask Claude on a question, Suggest a fix, a concern dismissed' },
  { name: 'branches', file: 'check/branches.ts', tests: branchesTests, covers: 'drift, other branches, a branch switch while writing, another git user' },
  { name: 'checkFile', file: 'check/checkFile.ts', tests: checkFileTests, covers: 'the check file rewritten, conflicted, broken, merged' },
  { name: 'tour', file: 'check/tour.ts', tests: tourTests, covers: 'questions written in the background, the tour of the change' },
  { name: 'journeysView', file: 'check/journeysView.ts', tests: journeysViewTests, covers: 'the Journeys view (a guest: this workspace has a journey in the repository)' },
  { name: 'refresh', file: 'check/refresh.ts', tests: refreshTests, covers: 'the view\'s errors, refreshes, calls into the window, a double Ctrl+Enter' },
]

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The entry point run.ts starts VS Code with (extensionTestsPath): the setup every phase depends on, then the phases. */
export async function run(): Promise<void> {
  const { api, ws } = await activateCheck()
  const understandingDir = path.join(ws, 'understanding')
  // The state a timed-out wait prints (a phase may swap it for its own with withDumpState).
  setDumpState(() => ({
    notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]),
    u: fs.existsSync(understandingDir) && fs.readdirSync(understandingDir),
    files: fs.readdirSync(ws),
    check: chk(),
  }))
  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)
  // No tour until the tour phase (the fake Claude gives up on it): the phases before are about the questions alone.
  setFakeScenario({ noTour: true })
  await runChapters('code-notes understanding check', phases, { scenario: true })
  console.log('all passed')
}
