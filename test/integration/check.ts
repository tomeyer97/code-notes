// Runs inside a real VS Code (see run.ts, check()): the understanding check end to end with a fake Claude
// (test/fixtures/fake-grader.js): questions written with the skill's script, answered in their threads, graded,
// the file updated, the threshold met, the file staged. The workspace is a git repository on a branch with a change.
// One test per behaviour, in order: each starts where the previous one left the repository and the window. Tests
// marked "DevTools" type and click for real in the workbench page (devtools.ts) and are skipped without the port.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import assert from 'assert'
import { REFRESH_SOON_MS } from '../../src/check/constants'
import type { TestApi } from '../../src/testApi'
import { callCounter } from './roundTrips'
import { activate, quiet, runTests, SCALE, settle, test, untilEqual, waiter, windowShot } from './helpers'
import { boxFocused, cdp, checkFrame, clickToast, focusedElement, pageShot, ui } from './devtools'

/** What a timed-out wait prints: the check's state, or what the test running wants to see instead. */
let dumpState: () => unknown = () => undefined
/** This suite's waits, until's and untilEqual's: 10 s by default (questions are written and graded by a script). */
const CHECK_WAIT_MS = 10000
/** This suite's wait, the state printed on a timeout. */
const until = waiter({ ms: CHECK_WAIT_MS, dump: () => dumpState() })

/** The extension's check refresh debounce: file events, focus and saves wait this long (src/check/constants.ts). */
const CHECK_DEBOUNCE_MS = REFRESH_SOON_MS

const ws = vscode.workspace.workspaceFolders![0].uri.fsPath
let api: TestApi
const checkFile = path.join(ws, 'understanding/feat-limits.json')
const limitsPath = path.join(ws, 'api/limits.js')
const understandingCli = path.join(__dirname, '../../../cli/understanding.mjs')

/** The check's state (the extension has one: this window's folder is a git checkout). */
const chk = () => api.check()!
/** What the Check view shows now. */
const view = () => chk().view!
const readCheck = () => JSON.parse(fs.readFileSync(checkFile, 'utf8'))
const readCheckOr = () => { try { return readCheck() } catch { return undefined } }
const checkNotes = () => (api.snapshot().notes as any[]).filter((n) => n.session === 'Check · feat/limits')
const noteOf = (q: string) => checkNotes().find((n) => n.extra?.check?.q === q)
const noteById = (id: string) => (api.snapshot().notes as any[]).find((n) => n.id === id)
const git = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' }).trim()
const ciOutput = () => execFileSync('node', [understandingCli, 'ci', '--base', 'main'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH } })
// The code editor's caret (the keyboard may be in the Check view's box, where there is no active editor).
const codeEditor = () => { const a = vscode.window.activeTextEditor; return a?.document.uri.scheme === 'file' ? a : vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file') }
const editorLine = () => codeEditor()?.selection.active.line
const inLines = (a: number, b: number) => { const l = editorLine(); return l !== undefined && l >= a && l <= b }
const limitsEditor = () => vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath === limitsPath)
const commentBody = (c: vscode.Comment) => (c.body as vscode.MarkdownString).value
const threadComments = (id: string) => api.thread(id)!.comments as vscode.Comment[]

/** Answers a check question through its thread's reply (the command the Answer button runs). */
async function answer(q: string, text: string): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(noteOf(q).id), text })
}
const lastBody = (q: string) => { const m = noteOf(q).messages; return m[m.length - 1].body as string }

/** The Check view's main button shows `label`, on screen and clickable (nothing over it). */
const buttonShown = async (label: string) => (await checkFrame()).evaluate((l) => {
  const d = (globalThis as any).document, b = d.querySelector('footer button.primary')
  if (!b || b.textContent !== l) return false
  const r = b.getBoundingClientRect()
  return r.top >= 0 && r.bottom <= (globalThis as any).innerHeight && d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b
}, label)

// The check's tour (feat/tour).
const tourFile = path.join(ws, 'understanding/feat-tour.json')
const readTour = () => JSON.parse(fs.readFileSync(tourFile, 'utf8'))
const tourNote = (q: string) => (api.snapshot().notes as any[]).find((n) => n.session === 'Check · feat/tour' && n.extra?.check?.q === q)
const tour = () => api.snapshot().tour

// What earlier tests leave for later ones.
let q1Note: any
/** The note asked from q1 (Ask Claude on a check question) and the one from Suggest a fix: hidden on other branches. */
let askedNote: any, fixNote: any
/** The check file as it was before the rewrite and conflict tests changed it on disk. */
let checkFileText = ''
/** limits.js as it was when q2 was missed: typing away from the box must leave it so. */
let limitsText = ''

/** Real keys, as someone answering would type them next: none of it may reach the code. */
async function typeAway(what: string): Promise<void> {
  if (!cdp) return
  const page = await ui()
  await page.keyboard.type('my answer goes here')
  await page.keyboard.press('Enter'); await page.keyboard.press('Backspace')
  await quiet(300, 'a keystroke reaching the code')
  assert.equal(fs.readFileSync(limitsPath, 'utf8'), limitsText, `${what}: the file on disk is untouched`)
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === limitsPath)
  assert.ok(!doc?.isDirty, `${what}: the code in the editor is untouched`)
  assert.equal(doc?.getText(), limitsText, `${what}: no keystroke in the code`)
}

/** The visible columns of each code editor: its text area (after the gutter, before the minimap and scrollbar) in characters. */
async function codeColumns(page: import('playwright').Page): Promise<number[]> {
  return (await page.evaluate(`(() => {
    const out = []
    for (const e of document.querySelectorAll('.editor-group-container .monaco-editor')) {
      if (e.closest('.zone-widget') || e.parentElement.closest('.monaco-editor')) continue
      const r = e.getBoundingClientRect(); if (r.width < 50 || r.height < 50) continue
      const sc = e.querySelector('.editor-scrollable'); if (!sc) continue
      let right = r.right
      for (const x of [e.querySelector('.minimap'), sc.querySelector(':scope > .scrollbar.vertical')]) { const b = x && x.getBoundingClientRect(); if (b && b.width > 0) right = Math.min(right, b.left) }
      const line = [...e.querySelectorAll('.view-line')].find((l) => !l.closest('.zone-widget') && (l.textContent || '').trim().length > 10)
      if (!line) continue
      const span = line.firstElementChild
      out.push(Math.floor((right - sc.getBoundingClientRect().left) / (span.getBoundingClientRect().width / span.textContent.length)))
    }
    return out
  })()`)) as number[]
}

const devtools = { when: () => cdp, whenNot: 'no DevTools' }

const tests = [
  test('no check yet: "Understanding: start" in the status bar; "No check yet for feat/limits" and Start in the Check view', async () => {
    await until('status bar offers a check', () => chk()?.item === '$(checklist) Understanding: start')
    await vscode.commands.executeCommand('codeNotes.check.focus')
    await until('the view says there is no check yet', () => view()?.title === 'No check yet for feat/limits' && view().action?.id === 'start' && chk().panel.rows === 0)
  }),

  test('Start: no question asked about uncommitted work (the view names it); only question 1 opens (code + thread); the list is the Check view', async () => {
    // Uncommitted work doesn't stop the start: one line in the view names every file left out (modified ones too).
    fs.writeFileSync(path.join(ws, 'api', 'allowlist.js'), 'export const allow = []\n')
    fs.appendFileSync(path.join(ws, 'README.md'), '\nMore.\n')
    // Claude fails first (a model that doesn't exist): said in the view in plain words, Retry; no toast.
    fs.writeFileSync(path.join(ws, '.git', 'fake-write-error'), '')
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('the failure in the view', () => view()?.failed?.text === "Claude couldn't use the model." && view().failed!.setting === true && !view().action)
    await pageShot('check-0-failed')
    fs.rmSync(path.join(ws, '.git', 'fake-write-error'))
    api.checkPanelSend({ type: 'test', click: '.failed button.link' })
    await until('three question threads', () => checkNotes().length === 3)
    await until('Retry worked: the failure is gone', () => !view().failed)
    await until('what was left out', () => view().notice === 'Not asked about (uncommitted): README.md, allowlist.js')
    await pageShot('check-0-uncommitted')
    fs.rmSync(path.join(ws, 'api', 'allowlist.js')); git('checkout', '--', 'README.md')
    const written = readCheck()
    assert.deepEqual(written.questions.map((q: any) => q.kind), ['failure', 'why', 'edge'])
    assert.equal(written.head, git('rev-parse', 'HEAD'))
    q1Note = noteOf('q1')
    assert.deepEqual([q1Note.file, q1Note.range.start, q1Note.range.end], ['api/limits.js', 4, 7])
    assert.match(api.thread(q1Note.id)!.contextValue!, /check/)
    // Only question 1 opens: its code and its thread. No editor group for a list: it is in the sidebar.
    await until('q1\'s code on screen', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === limitsPath))
    await until('q1 open on its lines', () => noteById(q1Note.id)?.threadExpanded && inLines(3, 6))
    assert.equal(vscode.window.tabGroups.all.length, 1, 'one editor group')
    // One list of the questions: the Check view; the Code Notes tree doesn't repeat them.
    assert.ok(!(api.snapshot().tree() as string[]).some((l) => /What does allow\(\)|per customer rather|API process restarts/.test(l)), 'no check rows in the Code Notes tree')
    await until('q1 selected: its answer box', () => view()?.answer?.id === 'q1' && view().answer!.open)
    if (cdp) {
      // The keyboard is in q1's answer box in the Check view, not in the code (typing there would edit limits.js).
      const page = await ui()
      await until('focus in the answer box, not the code', async () => { const b = await boxFocused(); if (b !== 'q1') console.log('focus at start:', b, await focusedElement()); return b === 'q1' })
      await page.keyboard.type('typed')
      assert.equal(fs.readFileSync(limitsPath, 'utf8').includes('typed'), false)
      assert.ok(!vscode.window.activeTextEditor?.document.isDirty, 'the code is untouched')
      // An unsent answer is kept (this workspace, not the file).
      await until('the draft kept', () => view().answer?.draft === 'typed')
      assert.ok(!fs.readFileSync(checkFile, 'utf8').includes('typed'))
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace')
      await until('the draft gone', () => view().answer?.draft === '')
      // VS Code's own shortcuts still work from the box (Ctrl+G: go to line), and leave nothing in it.
      await page.keyboard.press('Control+G')
      await until('Go to Line opened from the box', () => page.locator('.quick-input-widget').isVisible())
      await page.keyboard.press('Escape')
      assert.equal(await (await checkFrame()).locator('.answer textarea').inputValue(), '', 'nothing typed into the box')
    }
    await until('the view lists three questions', () => chk().panel.rows === 3 && view().title === '0 of 3 done' && view().line === 'Answer all 3 · 2 must pass · ~2 min left.')
    await until('status bar 0/3', () => chk().item === '$(checklist) Understanding 0/3')
    assert.match(chk().itemLabel ?? '', /^Understanding check: 0 of 3 done\. Answer all 3/, 'read out as words, never an icon id')
    // Nothing written to the repository by itself (untracked setup files once blocked a checkout); nothing in the
    // workspace's settings. The first Commit & push of a check takes the .gitattributes line along.
    assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')) && !fs.existsSync(path.join(ws, '.ignore')), 'no setup files by themselves')
    assert.equal(vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude')?.['understanding/**'], undefined, 'no search.exclude written')
    assert.equal((view() as any).setup, undefined, 'no separate setup offer')
    await pageShot('check-1-questions')
  }),

  test('1280×800, no notes: the Code Notes view steps aside; the Check view shows all 3 questions and the answer box', async () => {
    // At 1280×800 (no zoom), with no notes: the empty Code Notes view steps aside and all three questions and q1's
    // answer box fit in the Check view without scrolling.
    const page = await ui()
    const session = await page.context().newCDPSession(page)
    await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global)
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await until('the empty Code Notes view steps aside', async () => !(await page.locator('.pane-header h3.title', { hasText: /^Code Notes$/ }).count()))
    const fit = await until('the Check view laid out', async () => {
      await settle(300, 'the view lays itself out at the new size before it is measured')
      const frame = await checkFrame()
      const m = await frame.evaluate(() => { const d = (globalThis as any).document, h = (globalThis as any).innerHeight; const rows = [...d.querySelectorAll('.row')]; return { h, scroll: d.documentElement.scrollHeight, rows: rows.length, cut: rows.map((r: any) => r.getBoundingClientRect().bottom).filter((b: number) => b > h + 1).length, box: !!d.querySelector('.answer textarea') } })
      return m.rows === 3 && m.box && m
    })
    await pageShot('check-1-fits')
    assert.ok(fit.cut === 0 && fit.scroll <= fit.h + 1, `all questions visible without scrolling: ${JSON.stringify(fit)}`)
    await session.send('Emulation.clearDeviceMetricsOverride')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', -2, vscode.ConfigurationTarget.Global)
    return `${fit.scroll} of ${fit.h} px`
  }, devtools),

  test('a good answer (typed in the reply box): "✓ Right." in the thread, the verdict in the file; the editor stays on q1 with the reply box cleared; "Next question ›" opens q2', async () => {
    if (cdp) {
      const page = await ui()
      await page.locator('.statusbar-item[aria-label*="Understanding check: 0 of 3 done"]').first().click()
      await settle(800, 'the status item opens q1 and its thread widget')
      await page.locator('.review-widget .review-thread-reply-button').first().click()
      await until('the keyboard in the thread\'s reply box', () => page.evaluate(() => !!(globalThis as any).document.activeElement?.closest?.('.review-widget .comment-form')))
      await page.keyboard.type('GOOD: the window starts over, so the count goes back to one.')
      await page.locator('.review-widget .monaco-button', { hasText: 'Answer' }).first().click()
    } else await answer('q1', 'GOOD: the window starts over, so the count goes back to one.')
    await until('q1 passed in the thread', () => lastBody('q1').startsWith('✓ Right.'))
    const attempt = readCheck().questions[0].attempts[0]
    assert.equal(attempt.verdict, 'pass'); assert.match(attempt.hash, /^[0-9a-f]{12}$/); assert.equal(attempt.note, 'Kept and sent again.')
    // The editor stays on the graded question (the feedback is the lesson); the reply box is empty again.
    await quiet(600, 'the editor moving off the graded question')
    const codeEd = limitsEditor()
    assert.ok(codeEd && codeEd.visibleRanges.some((r) => r.start.line <= 3 && r.end.line >= 6), 'still on q1: its lines in view')
    assert.ok(noteById(q1Note.id)?.threadExpanded, 'q1 open with its grade')
    assert.equal(api.thread(q1Note.id)!.state, vscode.CommentThreadState.Unresolved, 'never collapsed as "resolved"')
    const graded = threadComments(q1Note.id).at(-1)!.body as vscode.MarkdownString
    assert.match(graded.value, /^✓ Right\.[\s\S]*\[Next question ›\]\(command:codeNotes\.nextCheckQuestion\)$/)
    if (cdp) {
      const page = await ui()
      const replies = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form .view-lines')].map((e: any) => e.textContent).join('|'))
      assert.ok(!replies.includes('the window starts over'), `the reply box is cleared: ${replies}`)
      await pageShot('check-1b-graded')
      await page.locator('.review-widget .comment-body a', { hasText: 'Next question' }).first().click()
    } else await vscode.commands.executeCommand('codeNotes.nextCheckQuestion')
    await until('Next question opens q2', () => inLines(9, 11) && noteById(noteOf('q2').id)?.threadExpanded)
    assert.ok(api.thread(q1Note.id), 'the passed thread stays where it is')
    // A remark on a passed question with markdown in it: shown as typed in the thread (no heading, no rule).
    await answer('q1', '# not a heading\n---\n<b>x</b> [link](https://example.com)')
    await until('the remark shown as typed', () => threadComments(q1Note.id).some((c) => /^\\# not a heading/.test(commentBody(c)) && commentBody(c).includes('\\[link\\]') && !(c.body as vscode.MarkdownString).supportHtml))
  }),

  // One behaviour in three tests: the miss (here), the answer box in between (DevTools), then explained and restated.
  test('a miss keeps the editor on the question (nothing selected, thread open); the hint\'s code link lights the reset function and Back returns', async () => {
    if (cdp) {
      // Answered in the Check view's box: real keys, Ctrl+Enter; the same attempt as a thread reply.
      await until('focus in q2\'s box', async () => (await boxFocused()) === 'q2')
      await (await ui()).keyboard.type('Not sure.')
      await (await ui()).keyboard.press('Control+Enter')
      await until('the answer in the thread too', () => noteOf('q2').messages.some((m: any) => m.role === 'human' && m.body === 'Not sure.'))
    } else await answer('q2', 'Not sure.')
    await until('q2: try again with a hint', () => /^Not quite[\s\S]*\*\*Hint:\*\*/.test(lastBody('q2')))
    if (cdp) {
      // A grade that asks for more: the keyboard is back in the box by itself (no click), so what is typed next lands there.
      await until('after the retry grade: the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && view().answer?.grade && !view().answer!.checking)
      await (await ui()).keyboard.type('next try')
      assert.equal(await (await checkFrame()).locator('.answer textarea').inputValue(), 'next try', 'typed after the grade: in the box')
      await (await ui()).keyboard.press('Control+A'); await (await ui()).keyboard.press('Backspace')
    }
    const editor = limitsEditor()!
    assert.ok(editor.selection.isEmpty, `nothing selected: ${JSON.stringify(editor.selection)}`); assert.ok(inLines(9, 11), 'on the question')
    assert.ok(editor.visibleRanges.some((r) => r.start.line <= 9 && r.end.line >= 11), 'the question\'s lines are in view')
    assert.ok(noteById(noteOf('q2').id)?.threadExpanded, 'the thread stays open')
    assert.equal(view().rows[1].word, 'try again')
    // Code links: the hint names the code; a click lights those lines and brings them into view; Back returns to the question.
    const q2 = noteOf('q2'), hintAt = q2.messages.length - 1
    const linked = await until('the hint carries a code link', () => threadComments(q2.id).find((c) => commentBody(c)?.includes('command:codeNotes.codeLink')))
    assert.match(commentBody(linked!), /background-color:var\(--vscode-toolbar-hoverBackground\);">reset /)
    const caret = editor.selection
    limitsText = fs.readFileSync(limitsPath, 'utf8')
    if (cdp) await (await ui()).locator('.review-widget .comment-body a', { hasText: 'reset' }).first().click()
    else await vscode.commands.executeCommand('codeNotes.codeLink', `check|${q2.id}|${hintAt}`, 0)
    await until('the linked lines lit', () => api.snapshot().tour.codeLinks.active === 0)
    await untilEqual('the linked lines', () => { const at = api.snapshot().tour.codeLinks.at[0]; return [at?.start, at?.end] }, [10, 12], CHECK_WAIT_MS)
    // Only lit: nothing selected, the caret where it was.
    assert.ok(editor.selection.isEqual(caret), 'a code link moves no caret and selects nothing')
    await pageShot('check-2a-code-link')
    await typeAway('after a code link click')
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('back at the question', () => api.snapshot().tour.codeLinks.active === -1 && inLines(9, 11) && noteById(q2.id)?.threadExpanded)
    if (cdp) await until('Back: the keyboard in q2\'s box', async () => { const b = await boxFocused(); if (b !== 'q2') console.log('focus after Back:', b, await focusedElement()); return b === 'q2' })
    await typeAway('after Back')
  }),

  test('the Check view\'s answer box: the keyboard is there on open; Ctrl+Enter answers; its grade\'s code link lights the code and keeps the keyboard; drafts survive switching; Esc goes back to the code', async () => {
    // The grade under the box: its code link lights the code and the keyboard stays in the box.
    await until('the grade under the box', () => view().answer?.grade?.hint?.some((p: any) => p.link === 0))
    await pageShot('check-2b-box-grade')
    const frame = await checkFrame()
    await frame.locator('.answer .codelink', { hasText: 'the reset function' }).click()
    await until('lit from the view', () => api.snapshot().tour.codeLinks.active === 0)
    await until('the keyboard still in the box', async () => (await boxFocused()) === 'q2')
    await typeAway('after a code link in the view')
    assert.match(view().answer!.draft + (await frame.locator('.answer textarea').inputValue()), /my answer goes here/, 'the keys went into the box')
    // The draft survives switching questions.
    await vscode.commands.executeCommand('codeNotes.next')
    await until('on q3', () => view().answer?.id === 'q3')
    await vscode.commands.executeCommand('codeNotes.previous')
    await until('back on q2 with its draft', async () => view().answer?.id === 'q2' && /my answer goes here/.test(view().answer!.draft) && (await boxFocused()) === 'q2')
    // Esc: back to the code.
    await (await ui()).keyboard.press('Escape')
    await until('Esc: the editor has the keyboard', async () => (await boxFocused()) === '' && (await (await ui()).evaluate(() => !!(globalThis as any).document.activeElement?.closest?.('.monaco-editor'))))
  }, devtools),

  test('explained; said back rightly: restated, counts as passed', async () => {
    if (cdp) {
      // Back in q2's box (from q3), then answered by keyboard; after "explained" the restatement is typed with no click.
      await vscode.commands.executeCommand('codeNotes.next')
      await until('on q3', () => view().answer?.id === 'q3')
      await vscode.commands.executeCommand('codeNotes.previous')
      await until('q2\'s box has the keyboard', async () => view().answer?.id === 'q2' && (await boxFocused()) === 'q2')
      const page = await ui()
      await page.keyboard.press('Control+A'); await page.keyboard.type('Still not sure.'); await page.keyboard.press('Control+Enter')
    } else await answer('q2', 'Still not sure.')
    await until('q2 explained', () => /Got it\? Say it back in one sentence/.test(lastBody('q2')))
    // The first wrong answer is not kept: not in the file, not in the note.
    assert.equal(readCheck().questions[1].attempts[0].answer, undefined)
    // Nor its "Not quite" under it (it would talk about an answer no longer there); the explanation stays.
    await until('the first answer and its retry gone from the thread', () => !noteOf('q2').messages.some((m: any) => m.body === 'Not sure.' || /^Not quite/.test(m.body) || /not kept/.test(m.body)))
    assert.equal(view().rows[1].word, 'explained · say it back')
    if (cdp) {
      await until('after "explained": the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && !view().answer?.checking)
      const page = await ui()
      await page.keyboard.type('GOOD: the counts are per customer, so splitting orders does not help.')
      await page.keyboard.press('Control+Enter')
    } else await answer('q2', 'GOOD: the counts are per customer, so splitting orders does not help.')
    await until('q2 restated', () => lastBody('q2') === '✓ Right.')
    assert.ok(noteOf('q2').messages.some((m: any) => /^It retries with backoff/.test(m.body)), 'the explanation stays after saying it back')
    assert.deepEqual(readCheck().questions[1].attempts.map((a: any) => a.verdict), ['retry', 'explained', 'restated'])
    assert.equal(view().rows[1].word, 'in your words')
    await pageShot('check-2-restated')
  }),

  test('Ctrl+\' D opens the open question; the grader\'s concern shows on the row and in the thread; Flag for reviewer is stored in the file; Add TODO keeps it and says where the TODO went', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
    await vscode.commands.executeCommand('codeNotes.next')
    await until('D opens q3', () => codeEditor()?.document.uri.fsPath === limitsPath && noteById(noteOf('q3').id)?.threadExpanded)
    await answer('q3', 'GOOD CONCERN: they are in memory, so a restart forgets them.')
    await until('q3 passed with a concern', () => view()?.rows[2].flag === 'concern')
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'flag')
    await until('flagged in the file', () => readCheck().questions[2].concern?.flagged === true)
    await until('flagged on the row', () => view().rows[2].flag === 'flagged for review')
    // Add TODO next to the flag: one short line in the code, said in the thread; the flag stays.
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'todo')
    const todo = await until('a TODO in the code', () => { const ls = fs.readFileSync(limitsPath, 'utf8').split('\n'); const i = ls.findIndex((l) => l.includes('TODO')); return i >= 0 && ls.slice(i, i + 2) })
    // The whole concern (wrapped, nothing cut), at the line's indentation.
    assert.ok(todo.every((l) => l.length <= 100) && todo.map((l) => l.replace(/^\/\/( TODO:)?\s+/, '')).join(' ').includes('a restart lets everyone order again.'), `the whole concern: ${todo.join(' / ')}`)
    await until('said in the thread', () => threadComments(noteOf('q3').id).some((c) => /TODO added at limits\.js:1\b/.test(commentBody(c))))
    assert.equal(readCheck().questions[2].concern?.flagged, true, 'Add TODO keeps the flag')
  }),

  test('done: "✓ Done", Commit & push names and commits exactly the check file and, the first time, the .gitattributes line (the TODO is offered, not taken) and pushes with -u; the view says "Pushed."', async () => {
    await until('done', () => view()?.title === '✓ Done' && view().action?.id === 'commitPush' && view().line === 'A new file: not committed yet.')
    await until('status bar done', () => chk().item === '$(pass) Understanding')
    // The button is right under "✓ Done", on screen and clickable, whatever the questions below take.
    if (cdp) await until('Commit & push on screen, clickable', () => buttonShown('Commit & push'))
    // It names what it commits; the TODO added from the check is offered, not taken; other work is left alone.
    fs.writeFileSync(path.join(ws, 'api', 'scratch.js'), 'export const mine = 1\n')
    // The repository's first check: the line that folds check files in diffs goes with it, said on the same line.
    await until('what it commits', () => view().commits === 'Commits feat-limits.json, also folds check files in diffs (.gitattributes)' && view().also?.[0]?.label === 'also limits.js (TODO added)' && view().also![0].on === false)
    assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')), 'written only on Commit & push')
    await pageShot('check-3-done')
    // The status item does what the button does (Commit & push), not a jump to question 1.
    // The remote says how to open a merge request (as GitLab does for a branch without one).
    const remoteDir = git('remote', 'get-url', 'origin')
    fs.writeFileSync(path.join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\necho "To create a merge request for feat/limits, visit:"\necho "  https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits"\n', { mode: 0o755 })
    void vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('pushed', () => view()?.line === 'Pushed.' && !view().action, 20000)
    // Said where the person looks: the status bar says what went; the item uses the view's word; the merge request link.
    await until('the merge request link', () => view()?.mr === 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits')
    // The status item is redrawn after the view (it lagged one state behind in 2 of 4 runs: "Not pushed yet.").
    await until('the status item says "Pushed." too', () => /Done\. Pushed\.$/.test(chk().itemLabel ?? ''))
    assert.match(chk().itemLabel ?? '', /Done\. Pushed\.$/)
    if (cdp) {
      await until('the status bar says it', async () => (await (await ui()).locator('.statusbar-item', { hasText: 'Committed feat-limits.json, .gitattributes and pushed' }).count()) > 0)
      assert.ok(await (await checkFrame()).locator('.mr button.link', { hasText: 'Open merge request' }).isVisible(), 'the link is shown')
    }
    fs.rmSync(path.join(remoteDir, 'hooks', 'pre-receive'))
    assert.equal(git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0], git('rev-parse', 'HEAD'))
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitattributes', 'understanding/feat-limits.json'])
    assert.equal(fs.readFileSync(path.join(ws, '.gitattributes'), 'utf8'), 'understanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
    assert.ok(!fs.existsSync(path.join(ws, '.ignore')), '.ignore stays init\'s')
    assert.deepEqual(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? api/scratch.js', 'M api/limits.js'], 'the TODO and other work are left alone')
    fs.rmSync(path.join(ws, 'api', 'scratch.js')); git('checkout', '--', 'api/limits.js')
  }),

  test('`ci` passes the committed file without calling a model', async () => {
    assert.match(ciOutput(), /^✓ Understanding check done/)
  }),

  test('Ask Claude on a check question: a separate note on the same lines, the check thread unchanged', async () => {
    const before = noteOf('q1').messages.length
    await vscode.commands.executeCommand('codeNotes.askClaude', { thread: api.thread(noteOf('q1').id), text: 'What does counts hold?' })
    askedNote = await until('a separate note', () => (api.snapshot().notes as any[]).find((n) => n.messages[0]?.body === 'What does counts hold?'))
    assert.equal(askedNote.extra?.checkAsk, readCheck().questions[0].text); assert.equal(askedNote.session, undefined)
    assert.equal(noteOf('q1').messages.length, before)
    assert.ok((api.snapshot().tree() as string[]).some((l) => l.includes('What does counts hold?')), 'a note asked from a question is listed')
  }),

  test('Suggest a fix: a note asked to Claude; one sentence and a suggestion; Apply puts it in ("fix applied · not committed", offered with Commit & push), Undo takes it back', async () => {
    const limitsBefore = fs.readFileSync(limitsPath, 'utf8')
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'fix')
    fixNote = await until('a fix note', () => (api.snapshot().notes as any[]).find((n) => n.extra?.checkFix === 'q3'))
    assert.match(fixNote.messages[0].body, /^Suggest a fix: api\/limits\.js:2 keeps counts in memory/)
    const suggestion = await until('Claude suggests', () => noteById(fixNote.id)?.messages.find((m: any) => m.author === 'Claude'))
    assert.match(suggestion.body, /^Keep the counts somewhere that survives a restart\.\n\n```suggestion\n/)
    const applyLink = await until('an Apply link', () => (api.thread(fixNote.id)?.comments as vscode.Comment[] | undefined)?.find((c) => /\[Apply suggestion\]\(command:codeNotes\.applySuggestion/.test(commentBody(c))))
    await pageShot('check-6-suggest-fix')
    const args = JSON.parse(decodeURIComponent(/command:codeNotes\.applySuggestion\?([^ )]+)/.exec(commentBody(applyLink))![1]))
    await vscode.commands.executeCommand('codeNotes.applySuggestion', ...args)
    const limitsDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === limitsPath)!
    await until('applied', () => limitsDoc.getText().startsWith('// FIXED: counts survive a restart\n'))
    // The fix is said on its question and offered (ticked) with Commit & push, although the check file is pushed.
    await until('the applied fix offered', () => view()?.action?.label === 'Commit & push' && view().line === 'Your fix is not committed yet.' && view().rows[2].flag === 'fix applied · not committed' && view().also?.some((x: any) => x.label === 'limits.js (your fix)' && x.on))
    if (cdp) await until('Commit & push on screen with the fix', () => buttonShown('Commit & push'))
    await pageShot('check-6b-fix-applied')
    await vscode.window.showTextDocument(limitsDoc)
    await vscode.commands.executeCommand('undo')
    await until('undone', () => limitsDoc.getText() === limitsBefore)
    if (limitsDoc.isDirty) await limitsDoc.save()
    await until('undone: nothing left to commit', () => view()?.line === 'Pushed.' && !view().action)
  }),

  test('a concern dismissed with a reason (Dismiss, beside Mark fixed): kept in the file, gone from the thread, the row and the merge request', async () => {
    assert.ok(threadComments(noteOf('q3').id).some((c) => /\[Mark fixed\]\(command:codeNotes\.checkConcern[^)]*\) · \[Dismiss\]/.test(commentBody(c))), 'the quiet actions are there')
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'dismiss', 'A restart is fine: counts are per hour anyway.')
    await until('dismissed', () => readCheck().questions[2].concern?.dismissed?.reason === 'A restart is fine: counts are per hour anyway.' && readCheck().questions[2].concern.flagged === false && !view().rows[2].flag)
    await until('gone from the thread', () => !threadComments(noteOf('q3').id).some((c) => /Found while grading/.test(String((c.author as any)?.name))))
    assert.doesNotMatch(ciOutput(), /restart lets everyone/)
    git('commit', '-qam', 'dismissed')
  }),

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
    await until('check threads hidden on main', () => checkNotes().length === 0 && !api.thread(q1Note.id))
    // Notes made from the check (Ask Claude on a question, Suggest a fix) belong to the branch too: hidden, never "file not found".
    await until('notes from the check hidden on main', () => !(api.snapshot().notes as any[]).some((n) => n.extra?.checkFix || n.extra?.checkAsk) && !api.thread(askedNote.id) && !api.thread(fixNote.id))
    assert.equal(askedNote.extra?.checkFile, 'understanding/feat-limits.json')
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

  test('the check file rewritten on disk: a changed question gets a new thread, a removed one loses its thread', async () => {
    // Questions written again, a pull: threads follow; none stands for another question.
    const oldQ2 = (await until('q2\'s thread', () => noteOf('q2'))).id
    checkFileText = fs.readFileSync(checkFile, 'utf8')
    const rewritten = readCheck()
    rewritten.questions[1].text = 'Why does reset() take a customer instead of clearing every count?'; rewritten.questions[1].attempts = []
    rewritten.questions.splice(2, 1)
    fs.writeFileSync(checkFile, JSON.stringify(rewritten, null, 2) + '\n')
    await until('threads follow the rewritten file', () => checkNotes().length === 2 && noteOf('q2')?.id !== oldQ2 && noteOf('q2')?.messages[0].body === rewritten.questions[1].text && !api.thread(oldQ2))
    fs.writeFileSync(checkFile, checkFileText)
    await until('and back', () => checkNotes().length === 3 && noteOf('q3'))
  }),

  test('a merge conflict in the check file: "The check file has a merge conflict", Keep both answers merges it', async () => {
    const ours = readCheck()
    const theirs = { ...ours, updatedAt: '2026-11-16T09:00:00.000Z' }
    fs.writeFileSync(checkFile, ['<<<<<<< HEAD', JSON.stringify(ours, null, 2), '=======', JSON.stringify(theirs, null, 2), '>>>>>>> pairing', ''].join('\n'))
    await until('the conflict said', () => view()?.title === 'The check file has a merge conflict' && view().action?.id === 'merge' && chk().item === '$(warning) Understanding: merge conflict')
    await pageShot('check-7-conflict')
    api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
    await until('merged', () => !fs.readFileSync(checkFile, 'utf8').includes('<<<<<<<') && view()?.title === '✓ Done' && checkNotes().length === 3)
    fs.writeFileSync(checkFile, checkFileText)
  }),

  test('a check file broken by hand: "Line 2: …" in the view, Open puts the caret where it breaks', async () => {
    fs.writeFileSync(checkFile, checkFileText.replace('"version": 1,', '"version": 1,,'))
    await until('where it breaks', () => /^Line 2: /.test(view()?.line ?? '') && view().action?.id === 'openFile')
    api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
    await until('Open: at the error', () => vscode.window.activeTextEditor?.document.uri.fsPath === checkFile && vscode.window.activeTextEditor.selection.active.line === 1 && vscode.window.activeTextEditor.selection.active.character > 0)
    fs.writeFileSync(checkFile, checkFileText)
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
    await until('readable again', () => view()?.title === '✓ Done')
  }),

  test('a real merge conflict: Keep both keeps the flag a teammate set (said in one line); Commit & push concludes the merge and pushes', async () => {
    // A teammate flagged q3's concern, Ada dismissed it (again). Keep both: the flag stays, said; Commit & push
    // concludes the merge and pushes it.
    await until('clean before the merge', () => git('status', '--porcelain', '--', 'understanding/feat-limits.json') === '' && view()?.title === '✓ Done')
    git('checkout', '-q', '-b', 'feat/limits-bob')
    const bob = readCheck(); bob.questions[2].concern = { text: bob.questions[2].concern.text, flagged: true }
    fs.writeFileSync(checkFile, JSON.stringify(bob, null, 2) + '\n'); git('commit', '-qam', 'bob flags q3')
    git('checkout', '-q', 'feat/limits')
    const ada = readCheck(); ada.questions[2].concern.dismissed.reason = 'Counts are per hour: a restart is harmless.'
    fs.writeFileSync(checkFile, JSON.stringify(ada, null, 2) + '\n'); git('commit', '-qam', 'ada dismisses q3')
    try { git('merge', '-q', '--no-edit', 'feat/limits-bob') } catch { /* the conflict */ }
    api.checkRefresh()
    await until('the real conflict said', () => view()?.action?.id === 'merge')
    api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
    await until('kept both, the flag kept and said', () => readCheckOr()?.questions[2].concern?.flagged === true && /Question 3: its concern stays flagged/.test(view()?.said ?? '') && view().action?.id === 'commitPush')
    if (cdp) await until('Commit & push on screen after the merge', () => buttonShown('Commit & push'))
    api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
    await until('the merge concluded and pushed', () => !fs.existsSync(path.join(ws, '.git', 'MERGE_HEAD')) && git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0] === git('rev-parse', 'HEAD'), 20000)
  }),

  test('pushed without a check: questions written in the background, "1 question ready" (stacked: only its own line), nothing opens; a click opens question 1', async () => {
    git('checkout', '-q', '-b', 'feat/third')
    fs.writeFileSync(path.join(ws, 'api', 'third.js'), 'export const third = 3\n')
    git('add', '-A', 'api/third.js'); git('commit', '-qm', 'third')
    api.checkRefresh()
    await until('no check yet on feat/third', () => view()?.title === 'No check yet for feat/third')
    const where = vscode.window.activeTextEditor?.document.uri.fsPath
    // As in real use, VS Code's git has seen the branch before it is pushed.
    await until('git sees feat/third', () => (chk().bg as string[]).includes('feat/third unpushed (new)'), 20000)
    git('push', '-q', '-u', 'origin', 'feat/third')
    await until('questions ready in the background', () => chk().item === '$(checklist) 1 question ready', 40000)
    assert.ok(fs.existsSync(path.join(ws, 'understanding/feat-third.json')))
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, where, 'nothing opened by itself')
    await pageShot('check-5-ready')
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('a click opens q1', () => codeEditor()?.document.uri.fsPath === path.join(ws, 'api/third.js') && chk().item === '$(checklist) Understanding 0/1')
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('feat/limits once more', () => chk().item === '$(pass) Understanding')
  }),

  // The tour of the change: written right after the questions, walked in the journey panel with the questions as
  // stops between the steps; a pass stays, Next walks on; rows of the Check view and of the storyline go to their step
  // and question.
  test('the tour is written right after the questions; a branch switch stops it and it goes on on return: each question after a step; rows say "step n"; not listed as a journey', async () => {
    fs.rmSync(path.join(ws, '.git', 'fake-no-tour'), { force: true })
    git('checkout', '-q', '-b', 'feat/tour', 'main')
    git('checkout', 'feat/limits', '--', 'api/limits.js')
    git('commit', '-qm', 'limits for the tour')
    api.checkRefresh()
    await until('no check yet on feat/tour', () => view()?.title === 'No check yet for feat/tour')
    // The branch is switched while the tour is written: it stops (nothing written to the other branch) and goes on
    // once the branch is back.
    fs.writeFileSync(path.join(ws, '.git', 'fake-tour-wait'), '')
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('q1 opens before the tour is there', () => tourNote('q1')?.threadExpanded)
    await until('the tour is being written', () => fs.existsSync(path.join(ws, '.git', 'fake-tour-wait-waiting')) && view()?.tour?.label?.startsWith('Writing the tour'), 20000)
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('switched away: the tour stops, said nowhere on feat/limits', () => !chk().tourBusy && chk().item === '$(pass) Understanding' && !view()?.tour?.label?.startsWith('Writing'))
    fs.rmSync(path.join(ws, '.git', 'fake-tour-wait')); fs.rmSync(path.join(ws, '.git', 'fake-tour-wait-waiting'), { force: true })
    assert.equal(fs.readFileSync(checkFile, 'utf8').includes('"journey"'), false, 'no tour written into feat/limits\'s check')
    git('checkout', '-q', 'feat/tour')
    api.checkRefresh()
    const t0 = Date.now()
    await until('back: the tour goes on', () => chk().tourBusy || (fs.existsSync(tourFile) && readTour().journey), 20000)
    await until('the tour, right after the questions', () => fs.existsSync(tourFile) && readTour().journey?.steps.length === 6, 30000)
    assert.deepEqual(readTour().questions.map((q: any) => q.step), [2, 4, 4])
    await until('rows say their step; the tour link', () => view()?.tour?.label === 'Walk the tour · 6 steps' && view().rows.map((r: any) => r.step).join() === '2,4,4')
    assert.ok(!(api.snapshot().journeys as any[]).some((x) => /^check-/.test(x.id)), 'a check\'s tour is not one of the journeys')
    assert.ok(!(api.journeysTree() as string[]).some((l) => /Order limits/.test(l)), 'nor in the Journeys view')
    await pageShot('tour-0-check-view')
    return `${((Date.now() - t0) / 1000).toFixed(1)} s with the fake`
  }),

  test('Walk it: step 1 with the questions as rows between the steps; Next past step 2 opens q1 (keyboard in its answer box; card: "Question ›"); a pass stays, Next walks on to step 3', async () => {
    if (cdp) await clickToast(/The tour of your change is ready/, 'Walk it')
    else api.checkPanelSend({ type: 'test', click: 'button.tour' })
    await until('walking: step 1, the map', () => { const t = tour(); return t.journey === 'check-feat-tour' && t.step === 1 && t.map === 'check-feat-tour' }, 15000)
    await untilEqual('walking: 6 steps with the questions between them', () => [tour().story?.steps, tour().story?.stops.join(), !!tour().story?.cur], [6, 'q1,q2,q3', false], CHECK_WAIT_MS)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2: its card\'s Next is "Question ›"', () => tour().step === 2 && /\[Question ›\]\(command:codeNotes\.nextStep\)/.test(tour().card?.body ?? ''))
    await pageShot('tour-1-step')
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('at q1: its thread open, its row the current one', () => { const t = tour(); return t.step === 2 && t.cp === 'q1' && t.story?.cur === 'q1' && tourNote('q1')?.threadExpanded && inLines(3, 7) })
    if (cdp) await until('the keyboard in q1\'s answer box', async () => (await boxFocused()) === 'q1')
    await pageShot('tour-2-question')
    await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(tourNote('q1').id), text: 'GOOD: after an hour the count starts again at one.' })
    // A pass keeps the editor on the question (its feedback is the lesson); Next walks on.
    await until('a pass stays on q1', () => tour().step === 2 && tour().cp === 'q1' && /^✓/.test(tourNote('q1').messages.at(-1).body))
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Next walks on: step 3', () => tour().step === 3 && !tour().cp)
  }),

  test('rows of the Check view and of the storyline go to their step and question; Next/Previous move between the questions after a step; the last step says "See also: Order and payment, step 3"', async () => {
    api.checkPanelSend({ type: 'test', click: 'button.open[data-id="q3"]' })
    await until('a Check view row: its step and its question', () => tour().step === 4 && tour().cp === 'q3' && tourNote('q3')?.threadExpanded)
    api.mapSend({ type: 'test', click: '.story .cp[data-q="q2"]' })
    await until('a storyline row: its question', () => tour().step === 4 && tour().cp === 'q2' && tour().story?.cur === 'q2' && tourNote('q2')?.threadExpanded)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Next: the other question after step 4', () => tour().cp === 'q3')
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('Previous: back to q2', () => tour().cp === 'q2')
    await vscode.commands.executeCommand('codeNotes.nextStep'); await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('then step 5', () => tour().step === 5 && !tour().cp)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('the last step: See also the journey that walks the same code', () => tour().step === 6 && /See also: \[Order and payment, step 3\]\(command:codeNotes\.openStepLink/.test(tour().card?.body ?? ''))
    await pageShot('tour-3-last-step')
    assert.deepEqual(tour().story!.overflow, [], 'nothing in the storyline is cut or sticks out')
  }),

  // One behaviour in two tests (the 1280 px walk, DevTools only, comes between): walks from where it was left, then
  // gone on another branch.
  test('Check my understanding walks the tour from where it was left', async () => {
    // Opening the check again walks the tour where it was left; the grader is given the tour.
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('Check my understanding walks the tour', () => tour().journey === 'check-feat-tour' && tour().step === 6 && tour().touring)
  }),

  test('a 1280 px window: the tour walks with the step card only, "Question ›" opens no panel; typing after a step\'s code link changes nothing', async () => {
    // A 1280 px window (zoom 0, the sidebar open): the walk keeps 80 columns of code (the step card only, no panel),
    // and "Question ›" opens no panel. A code link in a step card only lights its lines: typing next changes nothing.
    const page = await ui()
    const session = await page.context().newCDPSession(page)
    const zoom = vscode.workspace.getConfiguration('window').inspect<number>('zoomLevel')?.globalValue
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    // The secondary side bar (Chat) closed, as in the reported window: its width is the reader's to give.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global)
    // The window's size as the workbench sees it (Electron has no Browser.setWindowBounds over DevTools).
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await until('a 1280 px window', async () => (await page.evaluate('innerWidth')) === 1280)
    await vscode.commands.executeCommand('codeNotes.check.focus')
    await settle(500, 'the Check view takes the side bar at the new width')
    const dumpBefore = dumpState
    dumpState = () => ({ tour: { ...tour(), story: undefined }, width: 1280 })
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('walking the tour at 1280 px: the step card only', () => tour().journey === 'check-feat-tour' && tour().touring && !!tour().card && !tour().map)
    // Back from the last step to step 3: through the questions after step 4 (each opens its thread, never the panel).
    for (const want of ['5', 'q3', 'q2', '4', '3']) {
      await vscode.commands.executeCommand('codeNotes.previousStep')
      await until(`back to ${want}`, () => (want.startsWith('q') ? tour().cp === want : tour().step === Number(want) && !tour().cp) && !tour().map)
    }
    await until('step 3, its card with the code link "the count"', () => tour().step === 3 && />count<\/span>\]\(command:codeNotes\.codeLink/.test(tour().card?.body ?? '') && !tour().map)
    await settle(600, 'the step card and its code laid out at 1280 px before the columns are counted')
    await pageShot('tour-4-1280-step')
    let cols = await codeColumns(page)
    assert.ok(cols.length && Math.min(...cols) >= 80, `the code keeps 80 columns with the tour open: ${cols}`)
    // The code link, clicked for real; then keys, as someone reading on would type them.
    const limitsNow = fs.readFileSync(limitsPath, 'utf8')
    await page.locator('.review-widget .comment-body a', { hasText: 'count' }).first().click()
    await until('the link\'s lines lit', () => api.snapshot().tour.codeLinks.active === 0)
    await page.keyboard.type('zz'); await page.keyboard.press('Enter')
    await quiet(400, 'the keys reaching the code')
    const limitsDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === limitsPath)
    assert.ok(!limitsDoc?.isDirty && limitsDoc?.getText() === limitsNow, 'typing after a step\'s code link does not touch the code')
    // "Question ›": the question's thread, still no panel.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 4', () => tour().step === 4 && !tour().cp)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Question ›: q2, no panel', () => tour().cp === 'q2' && tourNote('q2')?.threadExpanded)
    await quiet(800, 'a panel opening for the question')
    assert.ok(!tour().map, 'a question opens no panel')
    cols = await codeColumns(page)
    assert.ok(cols.length && Math.min(...cols) >= 80, `the code keeps 80 columns at a question: ${cols}`)
    await pageShot('tour-5-1280-question')
    // Hovers and the status item (a Trusted Types error was reported around them): the console is checked at the end.
    await page.locator('.review-widget .comment-body a').first().hover().catch(() => undefined)
    await settle(800, 'the link\'s hover shows (the console is checked for its errors at the end)')
    const item = page.locator('.statusbar-item', { hasText: /Understanding/ }).first()
    await item.hover(); await settle(800, 'the status item\'s hover shows')
    await item.click(); await settle(800, 'the status item\'s click is handled')
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', zoom, vscode.ConfigurationTarget.Global)
    await session.send('Emulation.clearDeviceMetricsOverride')
    dumpState = dumpBefore
    await settle(500, 'the window back at its own size and zoom')
    return `${Math.min(...cols)} columns of code`
  }, devtools),

  test('another branch: that tour is gone', async () => {
    await vscode.commands.executeCommand('codeNotes.endJourney')
    // Nothing of feat/limits' .gitattributes may be left untracked here before the checkout (force: usually none).
    for (const f of ['.gitattributes', '.ignore']) fs.rmSync(path.join(ws, f), { force: true })
    git('checkout', '-q', 'feat/limits')
    api.checkRefresh()
    await until('feat/limits: no tour of feat/tour shown', () => chk().item === '$(pass) Understanding' && !(api.snapshot().tour.journey ?? '').startsWith('check-feat-tour'))
  }),

  test('Journeys view: "In this file" follows the editor; the search finds a word in a step\'s title', async () => {
    // Finding journeys (journeyList.ts).
    const journeysTree = () => api.journeysTree() as string[]
    const placeOrder = JSON.parse(fs.readFileSync(path.join(ws, 'journeys/place-order.json'), 'utf8'))
    const stepFile = placeOrder.steps[0].file as string
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, stepFile)))
    await until('"In this file" for a file a step is in', () => journeysTree()[0] === 'jgroup:In this file · 1' && /journey:/.test(journeysTree()[1]))
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
    await until('no "In this file" for a file no step is in', () => !journeysTree().some((l) => l.startsWith('jgroup:In this file')))
    const words = (t: string) => t.toLowerCase().match(/[a-z]{5,}/g) ?? []
    const own = new Set([...words(placeOrder.title), ...words(placeOrder.question), ...words(placeOrder.summary ?? '')])
    const word = placeOrder.steps.flatMap((x: any) => words(x.title)).find((w: string) => !own.has(w))
    assert.ok(word, 'a word only a step title has')
    const found = api.journeyList({ query: word })
    assert.ok(found.sections[0].keys.some((k: string) => found.rows[k].title === placeOrder.title), `"${word}" finds "${placeOrder.title}" by a step's title`)
    await vscode.commands.executeCommand('codeNotes.journeys.focus')
    await windowShot('journeys-sidebar', { wait: 600 })
    return `"${word}"`
  }),

  test('Check view: no errors, nothing cut or sticking out', async () => {
    // The view never showed an error or anything wider than itself.
    const panel = chk().panel
    assert.deepEqual(panel.errors, []); assert.deepEqual(panel.overflow, [])
  }),

  test('refresh: git status refreshes nothing, triggers coalesce, a commit goes through; a slow refresh never holds the event loop', async () => {
    // Refreshing costs nothing when nothing changed, and never stops the extension host.
    await until('settled on feat/limits', () => chk().item === '$(pass) Understanding')
    await api.checkRefresh()
    await settle(CHECK_DEBOUNCE_MS * 4, 'refreshes triggered earlier (file events, focus) run before the counts are taken')
    const atStart = chk().refreshes
    // `git status` (VS Code's Git view, a terminal, an agent) rewrites .git/index: nothing the check shows changed.
    for (let k = 0; k < 5; k++) git('status')
    await quiet(CHECK_DEBOUNCE_MS * 5, 'a refresh after git status rewrote .git/index')
    assert.equal(chk().refreshes.full, atStart.full, `git status refreshed the check: ${JSON.stringify([atStart, chk().refreshes])}`)
    // A burst of triggers (focus, saves, the Git view): one check of the key, plus at most one more; nothing read again.
    const beforeBurst = chk().refreshes
    await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh(false)))
    const afterBurst = chk().refreshes
    assert.equal(afterBurst.full, beforeBurst.full, 'nothing changed: no full refresh')
    assert.ok(afterBurst.same - beforeBurst.same <= 2, `coalesced: ${afterBurst.same - beforeBurst.same} checks for 10 triggers`)
    // Ten asked for at once while one runs: two refreshes, not ten.
    await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh()))
    assert.ok(chk().refreshes.full - afterBurst.full <= 2, `coalesced: ${chk().refreshes.full - afterBurst.full} refreshes for 10 calls`)
    // A change does go through: a commit (HEAD moves), seen without being asked.
    const beforeCommit = chk().refreshes
    fs.writeFileSync(path.join(ws, 'api', 'gate.js'), 'export const gate = 1\n')
    git('add', 'api/gate.js'); git('commit', '-qm', 'gate')
    await until('the commit refreshed the check', () => chk().refreshes.full > beforeCommit.full && chk().status?.head === git('rev-parse', 'HEAD'))
    // With git taking 0.25 s a call, a refresh takes seconds; the extension host's event loop never waits on it.
    const pathWas = process.env.PATH
    process.env.PATH = `${process.env.CODE_NOTES_SLOW_GIT}${path.delimiter}${pathWas}`
    api.checkRestartWorker() // its git: the slow one first on PATH
    fs.writeFileSync(path.join(ws, '.git', 'slow-git'), '')
    let worstStall = 0, lastTick = Date.now()
    const ticker = setInterval(() => { const t = Date.now(); worstStall = Math.max(worstStall, t - lastTick - 10); lastTick = t }, 10)
    const slowStart = Date.now()
    try { await api.checkRefresh() } finally {
      clearInterval(ticker); fs.rmSync(path.join(ws, '.git', 'slow-git'))
      process.env.PATH = pathWas; api.checkRestartWorker()
    }
    const took = Date.now() - slowStart
    assert.ok(took > 1500, `git was slow (${took} ms)`)
    assert.ok(worstStall < 30 * SCALE, `the extension host waited ${worstStall} ms during a ${took} ms refresh`)
    return `a ${took} ms refresh held the event loop ${worstStall} ms at most`
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

export async function run(): Promise<void> {
  api = await activate()
  dumpState = () => ({ notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]), u: fs.existsSync(path.join(ws, 'understanding')) && fs.readdirSync(path.join(ws, 'understanding')), files: fs.readdirSync(ws), check: chk() })
  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)
  // No tour until the tour tests (the fake Claude gives up on it): the tests before are about the questions alone.
  fs.writeFileSync(path.join(ws, '.git', 'fake-no-tour'), '')
  await runTests(tests)
}
