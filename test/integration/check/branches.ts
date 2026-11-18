// Drift and branches: uncommitted lines asking for a top-up, another branch hiding the check's threads, a branch switch
// while questions are written, another git user.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { test, untilEqual } from '../helpers'
import { pageShot } from '../devtools'
import { CHECK_WAIT_MS, api, checkFile, checkNotes, chk, git, left, limitsPath, until, view, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const branchesTests = [
  test('drift from uncommitted lines: amber "Needs top-up: +46 lines" in the status bar and the view (Commit… first)', async () => {
    const saved = fs.readFileSync(limitsPath, 'utf8')
    // 45 new lines (uncommitted) → amber "Needs top-up" before any push.
    fs.appendFileSync(limitsPath, Array.from({ length: 45 }, (_, i) => `export const MORE_${i} = ${i}`).join('\n') + '\n')
    await vscode.commands.executeCommand('workbench.action.files.revert').then(undefined, () => undefined)
    api.checkRefresh()
    await until('needs top-up', () => /^\$\(warning\) Needs top-up: \+4\d lines$/.test(chk().item))
    await untilEqual('the warning in the status bar and the view', () => [chk().itemWarn, view().tone, view().action?.id], [true, 'warn', 'scm'], CHECK_WAIT_MS)
    await pageShot('check-4-drift')
    fs.writeFileSync(limitsPath, saved)
    api.checkRefresh()
    await until('back to done', () => chk().item === '$(pass) Understanding')
  }),

  test('on another branch the check\'s threads and the notes made from them are hidden; back on the branch they return', async () => {
    git('checkout', '-q', 'main')
    api.checkRefresh()
    await until('check threads hidden on main', () => checkNotes().length === 0 && !api.thread(left.q1Note.id))
    // Notes made from the check (Ask Claude on a question, Suggest a fix) belong to the branch too: hidden, never "file not found".
    await until('notes from the check hidden on main', () => !(api.snapshot().notes as any[]).some((n) => n.extra?.checkFix || n.extra?.checkAsk) && !api.thread(left.askedNote.id) && !api.thread(left.fixNote.id))
    assert.equal(left.askedNote.extra?.checkFile, 'understanding/feat-limits.json')
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('back on the branch', () => checkNotes().length === 3 && (api.snapshot().notes as any[]).filter((n) => n.extra?.checkFix || n.extra?.checkAsk).every((n) => !n.missing))
  }),

  test('a branch switch while questions are written: they are written for the branch and commit they were started on, kept in .code-notes/.cache (git-ignored), nothing touches the branch checked out, and they are put in place on return', async () => {
    git('checkout', '-q', '-b', 'feat/second')
    fs.appendFileSync(limitsPath, Array.from({ length: 30 }, (_, i) => `export const SECOND_${i} = ${i}`).join('\n') + '\n')
    git('commit', '-qam', 'second')
    api.checkRefresh()
    await until('no check yet on feat/second', () => view()?.title === 'No check yet for feat/second')
    const gitDir = path.join(ws, '.git')
    const secondHead = git('rev-parse', 'HEAD')
    // Switched before the writer even starts (Claude takes seconds to get going): everything is still for feat/second.
    fs.writeFileSync(path.join(gitDir, 'fake-slow-start'), '')
    const job = vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('the writer is waiting', () => fs.existsSync(path.join(gitDir, 'fake-slow-start-waiting')), 20000)
    const limitsCheck = fs.readFileSync(checkFile, 'utf8')
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('feat/limits\'s view names the other branch', () => /^Writing questions for feat\/second/.test(view()?.busy ?? ''))
    fs.rmSync(path.join(gitDir, 'fake-slow-start'))
    await job
    const cached = path.join(ws, '.code-notes/.cache/checks/feat-second.json')
    await until('kept in the cache', () => fs.existsSync(cached) && !fs.existsSync(path.join(ws, 'understanding/feat-second.json')))
    assert.equal(fs.readFileSync(path.join(ws, '.code-notes/.cache/.gitignore'), 'utf8'), '*\n')
    const secondCheck = JSON.parse(fs.readFileSync(cached, 'utf8'))
    assert.deepEqual([secondCheck.branch, secondCheck.head, secondCheck.questions.length], ['feat/second', secondHead, 2], 'written for feat/second at its commit, about its own 30 lines (stacked on feat/limits\'s check)')
    // Nothing was written to the branch checked out meanwhile.
    assert.equal(fs.readFileSync(checkFile, 'utf8'), limitsCheck, 'feat/limits\'s check untouched')
    assert.equal(git('status', '--porcelain'), '', 'feat/limits: nothing new in the working tree')
    git('checkout', '-q', 'feat/second')
    api.checkRefresh()
    await until('put in place on return', () => fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && !fs.existsSync(cached) && view()?.title === '0 of 2 done')
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('feat/limits again', () => chk().item === '$(pass) Understanding')
    // feat/second's unfinished (untracked) check doesn't follow to feat/limits: it waits in the cache for its branch.
    await until('feat/second\'s check parked', () => !fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && fs.existsSync(cached))
    assert.equal(git('status', '--porcelain', '--', 'understanding'), '', 'feat/limits: no other branch\'s check in the tree')
  }),

  test('another git user: "Ada\'s check: your answers are recorded as yours."', async () => {
    // Someone else answering: one line in the view, nothing blocked.
    git('config', 'user.name', 'Bob'); git('config', 'user.email', 'bob@example.com')
    api.checkRefresh()
    await until('whose check', () => view()?.who === "Ada's check: your answers are recorded as yours.")
    git('config', 'user.name', 'Ada'); git('config', 'user.email', 'ada@example.com')
  }),
]
