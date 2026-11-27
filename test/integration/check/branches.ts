// Drift and branches: uncommitted lines asking for a top-up, another branch hiding the check's threads, a branch switch
// while questions are written, another git user. Each test puts the branch, the files and the git config back in
// `finally`, so a failure here doesn't leave the next tests on another branch.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test, untilEqual } from '../helpers'
import { pageShot } from '../devtools'
import { CHECK_WAIT_MS, api, checkFile, checkNotes, chk, git, left, limitsPath, until, view, ws } from './context'
import { fakeHolding, releaseFake, setFakeScenario } from './fakeGrader'
import { notesFromCheck } from './support'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Checks out `branch` and tells the check (as VS Code's git would). */
function checkout(branch: string): void {
  git('checkout', '-q', branch)
  void api.checkRefresh()
}

/** `checkout` in a `finally`: a failure to go back is printed, so it doesn't hide the test's own failure. */
function backTo(branch: string): void {
  try { checkout(branch) } catch (e) { console.log(`    could not go back to ${branch}: ${(e as Error).message}`) }
}

export const branchesTests = [
  test('drift from uncommitted lines: amber "Needs top-up: +46 lines" in the status bar and the view (Commit… first)', async () => {
    const saved = fs.readFileSync(limitsPath, 'utf8')
    try {
      // 45 new lines (uncommitted) → amber "Needs top-up" before any push.
      fs.appendFileSync(limitsPath, Array.from({ length: 45 }, (_, i) => `export const MORE_${i} = ${i}`).join('\n') + '\n')
      await vscode.commands.executeCommand('workbench.action.files.revert').then(undefined, () => undefined)
      void api.checkRefresh()
      await until('needs top-up', () => /^\$\(warning\) Needs top-up: \+4\d lines$/.test(chk().item))
      await untilEqual('the warning in the status bar and the view', () => [chk().itemWarn, view().tone, view().action?.id], [true, 'warn', 'scm'], CHECK_WAIT_MS)
      await pageShot('check-4-drift')
    } finally {
      fs.writeFileSync(limitsPath, saved)
      void api.checkRefresh()
    }
    await until('back to done', () => chk().item === '$(pass) Understanding')
  }),

  test('on another branch the check\'s threads and the notes made from them are hidden; back on the branch they return', async () => {
    checkout('main')
    try {
      await until('check threads hidden on main', () => checkNotes().length === 0 && !api.thread(left.q1Note.id))
      // Notes made from the check (Ask Claude on a question, Suggest a fix) belong to the branch too: hidden, never "file not found".
      await until('notes from the check hidden on main', () => !notesFromCheck().length && !api.thread(left.askedNote.id) && !api.thread(left.fixNote.id))
      assert.equal(left.askedNote.extra?.checkFile, 'understanding/feat-limits.json')
      // The default branch with no check file: codeNotes.checkOnBase hides the Check view (package.json).
      await until('codeNotes.checkOnBase on main', () => chk().onBase === true)
    } finally { backTo('feat/limits') }
    await until('back on the branch', () => checkNotes().length === 3 && notesFromCheck().every((n) => !n.missing))
    assert.equal(chk().onBase, false, 'a feature branch shows the Check view')
  }),

  test('a branch switch while questions are written: they are written for the branch and commit they were started on, kept in .code-notes/.cache (git-ignored), nothing touches the branch checked out, and they are put in place on return', async () => {
    const cached = path.join(ws, '.code-notes/.cache/checks/feat-second.json')
    git('checkout', '-q', '-b', 'feat/second')
    try {
      fs.appendFileSync(limitsPath, Array.from({ length: 30 }, (_, i) => `export const SECOND_${i} = ${i}`).join('\n') + '\n')
      git('commit', '-qam', 'second')
      void api.checkRefresh()
      await until('no check yet on feat/second', () => view()?.title === 'No check yet for feat/second')
      const secondHead = git('rev-parse', 'HEAD')
      // Switched before the writer even starts (Claude takes seconds to get going): everything is still for feat/second.
      setFakeScenario({ hold: 'start' })
      try {
        const job = vscode.commands.executeCommand('codeNotes.checkUnderstanding')
        await until('the writer is waiting', () => fakeHolding('start'), 20000)
        const limitsCheck = fs.readFileSync(checkFile, 'utf8')
        checkout('feat/limits')
        await until('feat/limits\'s view names the other branch', () => /^Writing questions for feat\/second/.test(view()?.busy ?? ''))
        releaseFake()
        await job
        await until('kept in the cache', () => fs.existsSync(cached) && !fs.existsSync(path.join(ws, 'understanding/feat-second.json')))
        assert.equal(fs.readFileSync(path.join(ws, '.code-notes/.cache/.gitignore'), 'utf8'), '*\n')
        const secondCheck = JSON.parse(fs.readFileSync(cached, 'utf8'))
        assert.deepEqual([secondCheck.branch, secondCheck.head, secondCheck.questions.length], ['feat/second', secondHead, 2], 'written for feat/second at its commit, about its own 30 lines (stacked on feat/limits\'s check)')
        // Nothing was written to the branch checked out meanwhile.
        assert.equal(fs.readFileSync(checkFile, 'utf8'), limitsCheck, 'feat/limits\'s check untouched')
        assert.equal(git('status', '--porcelain'), '', 'feat/limits: nothing new in the working tree')
      } finally { releaseFake() }
      checkout('feat/second')
      await until('put in place on return', () => fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && !fs.existsSync(cached) && view()?.title === '0 of 2 done')
    } finally { backTo('feat/limits') }
    await until('feat/limits again', () => chk().item === '$(pass) Understanding')
    // feat/second's unfinished (untracked) check doesn't follow to feat/limits: it waits in the cache for its branch.
    await until('feat/second\'s check parked', () => !fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && fs.existsSync(cached))
    assert.equal(git('status', '--porcelain', '--', 'understanding'), '', 'feat/limits: no other branch\'s check in the tree')
  }),

  test('another git user: "Ada\'s check: your answers are recorded as yours."', async () => {
    // Someone else answering: one line in the view, nothing blocked.
    git('config', 'user.name', 'Bob'); git('config', 'user.email', 'bob@example.com')
    try {
      void api.checkRefresh()
      await until('whose check', () => view()?.who === "Ada's check: your answers are recorded as yours.")
    } finally { git('config', 'user.name', 'Ada'); git('config', 'user.email', 'ada@example.com') }
  }),
]
