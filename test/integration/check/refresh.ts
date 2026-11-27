// What the check costs: the Check view never showed an error; refreshes (git status, bursts, a commit, a slow git that
// never holds the event loop); calls into the window to open a question; a double Ctrl+Enter posting once.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { callCounter, quiet, settle, sleep, test } from '../helpers'
import { CHECK_DEBOUNCE_MS, api, chk, codeEditor, git, inLines, noteOf, until, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Long enough for refreshes triggered earlier (file events, focus) to have run: four debounces. */
const EARLIER_REFRESHES_MS = CHECK_DEBOUNCE_MS * 4
/** How long a refresh `git status` set off would take to show: five debounces. */
const GIT_STATUS_QUIET_MS = CHECK_DEBOUNCE_MS * 5
/** Ten triggers at once: the one that runs and at most one more after it. */
const MAX_REFRESHES_PER_BURST = 2
/** A refresh with the slow git takes at least this long, or git wasn't slow. */
const SLOW_REFRESH_MIN_MS = 1500
/** How much more of the time a refresh may hold the event loop than it is held idle (machine noise). */
const HELD_SHARE_MARGIN = 0.25
/** Stalls of a git call's length a refresh may cause beyond the idle rate (a few git calls on this thread). */
const EXTRA_LONG_STALLS = 2

export const refreshTests = [
  test('Check view: no errors, nothing cut or sticking out', async () => {
    // The view never showed an error or anything wider than itself.
    const panel = chk().panel
    assert.deepEqual(panel.errors, []); assert.deepEqual(panel.overflow, [])
  }),

  test('refresh: `git status` (it rewrites .git/index) refreshes nothing: nothing the check shows changed', async () => {
    // VS Code's Git view, a terminal or an agent runs it all the time.
    await until('settled on feat/limits', () => chk().item === '$(pass) Understanding')
    await api.checkRefresh()
    await settle(EARLIER_REFRESHES_MS, 'refreshes triggered earlier (file events, focus) run before the counts are taken')
    const atStart = chk().refreshes
    for (let k = 0; k < 5; k++) git('status')
    await quiet(GIT_STATUS_QUIET_MS, 'a refresh after git status rewrote .git/index')
    assert.equal(chk().refreshes.full, atStart.full, `git status refreshed the check: ${JSON.stringify([atStart, chk().refreshes])}`)
  }),

  test(`refresh: triggers coalesce: ten at once give at most ${MAX_REFRESHES_PER_BURST} checks, nothing read again when nothing changed`, async () => {
    // A burst of triggers (focus, saves, the Git view): one check of the key, plus at most one more.
    const beforeBurst = chk().refreshes
    await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh(false)))
    const afterBurst = chk().refreshes
    assert.equal(afterBurst.full, beforeBurst.full, 'nothing changed: no full refresh')
    assert.ok(afterBurst.same - beforeBurst.same <= MAX_REFRESHES_PER_BURST, `coalesced: ${afterBurst.same - beforeBurst.same} checks for 10 triggers`)
    // Ten asked for at once while one runs: two refreshes, not ten.
    await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh()))
    assert.ok(chk().refreshes.full - afterBurst.full <= MAX_REFRESHES_PER_BURST, `coalesced: ${chk().refreshes.full - afterBurst.full} refreshes for 10 calls`)
  }),

  test('refresh: a change goes through: a commit (HEAD moves) is seen without being asked', async () => {
    const beforeCommit = chk().refreshes
    fs.writeFileSync(path.join(ws, 'api', 'gate.js'), 'export const gate = 1\n')
    git('add', 'api/gate.js'); git('commit', '-qm', 'gate')
    await until('the commit refreshed the check', () => chk().refreshes.full > beforeCommit.full && chk().status?.head === git('rev-parse', 'HEAD'))
  }),

  // A timing check (it depends on the machine's load): the only one of this suite.
  test('refresh (timing): with git taking 0.25 s a call, a refresh takes seconds and never holds the extension host\'s event loop', async () => {
    // Measured as the share of the time the loop was held, against the same share with no refresh just before: a busy
    // machine holds it now and then (one stall alone says nothing), a refresh run on this thread holds it throughout.
    const idle = await loopHeld(() => sleep(2000))
    const slow = await withSlowGit(() => loopHeld(async () => { await api.checkRefresh() }))
    const said = `held the event loop ${pct(slow)} of a ${slow.ms} ms refresh (${slow.long} git calls' length in long stalls, worst ${slow.worst} ms) vs ${pct(idle)} idle (${idle.long}, worst ${idle.worst} ms)`
    assert.ok(slow.ms > SLOW_REFRESH_MIN_MS, `git was slow (${slow.ms} ms)`)
    // All of the refresh on this thread: held most of the time. A few git calls on it: as many stalls of their length.
    assert.ok(slow.held / slow.ms < idle.held / idle.ms + HELD_SHARE_MARGIN, `the extension host waited on the refresh: ${said}`)
    assert.ok(slow.long <= EXTRA_LONG_STALLS + (idle.long * slow.ms) / idle.ms, `the extension host waited on git calls: ${said}`)
    return said
  }),

  test('opening a question: one show, few calls into the window', async () => {
    // Calls into the window (each a round trip over a remote link).
    const counter = callCounter(api)
    try {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
      await settle(500, 'the extension\'s reactions to README.md in front (cursor, editor events) are over before counting')
      const opened = await counter.measure('opening a question', async () => api.checkOpenQuestion('q1'), () => inLines(3, 6) && /limits\.js$/.test(codeEditor()?.document.uri.path ?? ''))
      assert.ok(opened.calls.filter((x) => x.startsWith('show')).length <= 1 && opened.calls.length <= 3, `opening a question: ${opened.calls.join(', ')}`)
    } finally { counter.dispose() }
  }),

  test('a double Ctrl+Enter posts once', async () => {
    // Ctrl+Enter twice before the first one returns (the box keeps its text meanwhile): one message, not two.
    const thread = api.thread(noteOf('q1').id) as vscode.CommentThread
    const msgsBefore = noteOf('q1').messages.length
    await Promise.all([vscode.commands.executeCommand('codeNotes.answerCheck', { thread, text: 'Said twice.' }), vscode.commands.executeCommand('codeNotes.answerCheck', { thread, text: 'Said twice.' })])
    await until('the remark in the thread', () => noteOf('q1').messages.length > msgsBefore)
    await quiet(800, 'a second message for the second Ctrl+Enter')
    assert.equal(noteOf('q1').messages.length, msgsBefore + 1, 'one message for two Ctrl+Enter')
  }),
]

/**
 * How long the event loop was held while `run` ran: in all (`held`), the worst stall, how many slow git calls' length
 * (`long`: 0.25 s each, run.ts's slow git, less a little) it was held in stalls that long, and how long it ran (ms).
 */
type Held = { held: number; worst: number; long: number; ms: number }
const GIT_CALL_MS = 240

/** Ticks every 10 ms while `run` runs; a late tick is time the event loop was held. */
async function loopHeld(run: () => Promise<unknown>): Promise<Held> {
  let held = 0, worst = 0, long = 0, last = Date.now()
  const ticker = setInterval(() => {
    const t = Date.now(), late = Math.max(0, t - last - 10)
    held += late; worst = Math.max(worst, late); last = t
    long += Math.floor(late / GIT_CALL_MS)
  }, 10)
  const start = Date.now()
  let ms = 0
  try {
    await run()
    ms = Date.now() - start
    // One more tick: a stall at the very end of `run` shows only when the next tick comes.
    await sleep(30)
  } finally { clearInterval(ticker) }
  return { held, worst, long, ms }
}
const pct = (h: Held) => `${Math.round((100 * h.held) / Math.max(1, h.ms))}%`

/**
 * Runs `run` with the check's worker on run.ts's slow git (first on PATH; it is slow while .git/slow-git exists), then
 * puts the worker back on the usual git, failed or not. The worker takes the extension host's PATH when it starts.
 */
async function withSlowGit<T>(run: () => Promise<T>): Promise<T> {
  const pathWas = process.env.PATH
  process.env.PATH = `${process.env.CODE_NOTES_SLOW_GIT}${path.delimiter}${pathWas}`
  api.checkRestartWorker()
  fs.writeFileSync(path.join(ws, '.git', 'slow-git'), '')
  try { return await run() } finally {
    fs.rmSync(path.join(ws, '.git', 'slow-git'))
    process.env.PATH = pathWas; api.checkRestartWorker()
  }
}
