// Runs inside a real VS Code (see run.ts, checkRun): the understanding check end to end with a fake Claude
// (test/fixtures/fake-grader.js): questions written with the skill's script, answered in their threads, graded,
// the file updated, the threshold met, the file staged. The workspace is a git repository on a branch with a change.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import assert from 'assert'
import { callCounter } from './roundTrips'

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
/** The workbench page over the DevTools protocol (run.ts opens the port): real clicks and typing. */
let pagePromise: Promise<import('playwright').Page> | undefined
function ui(): Promise<import('playwright').Page> {
  return pagePromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright')
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CODE_NOTES_CDP}`)
    return b.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'))!
  })()
}
/** The Check view's frame (a webview: an iframe in an iframe), and which answer box has the keyboard ('' for none). */
async function checkFrame(): Promise<import('playwright').Frame> {
  const page = await ui()
  return until('the Check view frame', async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!(globalThis as any).checkAnswer)) return f } catch { /* detached */ } }
    return undefined
  })
}
async function boxFocused(): Promise<string> {
  return (await checkFrame()).evaluate(() => { const d = (globalThis as any).document; const a = d.activeElement; return d.hasFocus() && a?.classList?.contains('box') ? a.closest('.answer').dataset.id : '' })
}
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
  dump = () => ({ notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]), u: fs.existsSync(path.join(ws, 'understanding')) && fs.readdirSync(path.join(ws, 'understanding')), files: fs.readdirSync(ws), check: chk() })
  const shot = (name: string) => { const d = process.env.CODE_NOTES_SHOTS; if (d) execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)]) }

  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)
  // No tour until section 13 (the fake Claude gives up on it): the sections before are about the questions alone.
  fs.writeFileSync(path.join(ws, '.git', 'fake-no-tour'), '')
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' }).trim()
  const cdp = !!process.env.CODE_NOTES_CDP
  /** A whole-window screenshot over DevTools (CODE_NOTES_SHOTS=dir). */
  const shoot = async (name: string) => { const d = process.env.CODE_NOTES_SHOTS; if (d && cdp) { await sleep(400); await (await ui()).screenshot({ path: path.join(d, `${name}.png`) }) } }
  /** Clicks a notification's button (the real toast in the workbench). */
  const clickToast = async (text: RegExp, button: string) => {
    const page = await ui()
    const toast = page.locator('.notification-toast', { hasText: text }).first()
    await toast.waitFor({ timeout: 10000 * SCALE })
    await toast.locator('.monaco-button', { hasText: button }).first().click()
  }
  const view = () => chk().view
  // The code editor's caret (the keyboard may be in the Check view's box, where there is no active editor).
  const codeEditor = () => { const a = vscode.window.activeTextEditor; return a?.document.uri.scheme === 'file' ? a : vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file') }
  const editorLine = () => codeEditor()?.selection.active.line
  const inLines = (a: number, b: number) => { const l = editorLine(); return l !== undefined && l >= a && l <= b }

  // 1. A branch with a change and no check: the status bar says so; so does the Check view.
  await until('status bar offers a check', () => chk()?.item === '$(checklist) Understanding: start')
  await vscode.commands.executeCommand('codeNotes.check.focus')
  await until('the view says there is no check yet', () => view()?.title === 'No check yet for feat/limits' && view().action?.id === 'start' && chk().panel.rows === 0)
  ok('no check yet: "Understanding: start" in the status bar; "No check yet for feat/limits" and Start in the Check view')

  // 2. Uncommitted work doesn't stop the start: one line in the view names every file left out (modified ones too).
  fs.writeFileSync(path.join(ws, 'api', 'allowlist.js'), 'export const allow = []\n')
  fs.appendFileSync(path.join(ws, 'README.md'), '\nMore.\n')
  // Claude fails first (a model that doesn't exist): said in the view in plain words, Retry; no toast.
  fs.writeFileSync(path.join(ws, '.git', 'fake-write-error'), '')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('the failure in the view', () => view()?.failed?.text === "Claude couldn't use the model." && view().failed.setting === true && !view().action)
  await shoot('check-0-failed')
  fs.rmSync(path.join(ws, '.git', 'fake-write-error'))
  api.checkPanelSend({ type: 'test', click: '.failed button.link' })
  await until('three question threads', () => checkNotes().length === 3)
  await until('Retry worked: the failure is gone', () => !view().failed)
  await until('what was left out', () => chk().view.notice === 'Not asked about (uncommitted): README.md, allowlist.js')
  await shoot('check-0-uncommitted')
  fs.rmSync(path.join(ws, 'api', 'allowlist.js')); git('checkout', '--', 'README.md')
  const c0 = read()
  assert.deepEqual(c0.questions.map((q: any) => q.kind), ['failure', 'why', 'edge'])
  assert.equal(c0.head, git('rev-parse', 'HEAD'))
  const n1 = noteOf('q1')
  assert.deepEqual([n1.file, n1.range.start, n1.range.end], ['api/limits.js', 4, 7])
  assert.match(api.thread(n1.id).contextValue, /check/)
  // Only question 1 opens: its code and its thread. No editor group for a list: it is in the sidebar.
  await until('q1\'s code on screen', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === path.join(ws, 'api/limits.js')))
  await until('q1 open on its lines', () => api.snapshot().notes.find((n: any) => n.id === n1.id)?.threadExpanded && inLines(3, 6))
  assert.equal(vscode.window.tabGroups.all.length, 1, 'one editor group')
  // One list of the questions: the Check view; the Code Notes tree doesn't repeat them.
  assert.ok(!(api.snapshot().tree() as string[]).some((l) => /What does allow\(\)|per customer rather|API process restarts/.test(l)), 'no check rows in the Code Notes tree')
  await until('q1 selected: its answer box', () => view()?.answer?.id === 'q1' && view().answer.open)
  if (cdp) {
    // The keyboard is in q1's answer box in the Check view, not in the code (typing there would edit limits.js).
    const page = await ui()
    await until('focus in the answer box, not the code', async () => { const b = await boxFocused(); if (b !== 'q1') console.log('focus at start:', b, await page.evaluate(() => { const a = (globalThis as any).document.activeElement; return `${a?.tagName}.${a?.className}`.slice(0, 120) })); return b === 'q1' })
    await page.keyboard.type('typed')
    assert.equal(fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8').includes('typed'), false)
    assert.ok(!vscode.window.activeTextEditor?.document.isDirty, 'the code is untouched')
    // An unsent answer is kept (this workspace, not the file).
    await until('the draft kept', () => view().answer?.draft === 'typed')
    assert.ok(!fs.readFileSync(file, 'utf8').includes('typed'))
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
  if (cdp) {
    // At 1280×800 (no zoom), with no notes: the empty Code Notes view steps aside and all three questions and q1's
    // answer box fit in the Check view without scrolling.
    const page = await ui()
    const cdps = await page.context().newCDPSession(page)
    await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global)
    await cdps.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await until('the empty Code Notes view steps aside', async () => !(await page.locator('.pane-header h3.title', { hasText: /^Code Notes$/ }).count()))
    const fit = await until('the Check view laid out', async () => {
      await sleep(300)
      const fr = await checkFrame()
      const m = await fr.evaluate(() => { const d = (globalThis as any).document, h = (globalThis as any).innerHeight; const rows = [...d.querySelectorAll('.row')]; return { h, scroll: d.documentElement.scrollHeight, rows: rows.length, cut: rows.map((r: any) => r.getBoundingClientRect().bottom).filter((b: number) => b > h + 1).length, box: !!d.querySelector('.answer textarea') } })
      return m.rows === 3 && m.box && m
    })
    await shoot('check-1-fits')
    assert.ok(fit.cut === 0 && fit.scroll <= fit.h + 1, `all questions visible without scrolling: ${JSON.stringify(fit)}`)
    await cdps.send('Emulation.clearDeviceMetricsOverride')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', -2, vscode.ConfigurationTarget.Global)
    ok(`1280×800, no notes: the Code Notes view steps aside; the Check view shows all 3 questions and the answer box (${fit.scroll} of ${fit.h} px)`)
  }
  assert.match(chk().itemLabel, /^Understanding check: 0 of 3 done\. Answer all 3/, 'read out as words, never an icon id')
  // Nothing written to the repository by itself (untracked setup files once blocked a checkout); nothing in the
  // workspace's settings. The first Commit & push of a check takes the .gitattributes line along.
  assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')) && !fs.existsSync(path.join(ws, '.ignore')), 'no setup files by themselves')
  assert.equal(vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude')?.['understanding/**'], undefined, 'no search.exclude written')
  assert.equal((view() as any).setup, undefined, 'no separate setup offer')
  await shoot('check-1-questions')
  ok('Start: no question asked about uncommitted work (the view names it); only question 1 opens (code + thread); the list is the Check view')

  const answer = async (q: string, text: string) => {
    const n = noteOf(q)
    await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(n.id), text })
  }
  const lastBody = (q: string) => { const m = noteOf(q).messages; return m[m.length - 1].body as string }

  // 3. A good answer typed in the real reply box: ✓ in the thread, the verdict in the file; on to question 2.
  if (cdp) {
    const page = await ui()
    await page.locator('.statusbar-item[aria-label*="Understanding check: 0 of 3 done"]').first().click()
    await sleep(800)
    await page.locator('.review-widget .review-thread-reply-button').first().click()
    await sleep(400)
    await page.keyboard.type('GOOD: the window starts over, so the count goes back to one.')
    await page.locator('.review-widget .monaco-button', { hasText: 'Answer' }).first().click()
  } else await answer('q1', 'GOOD: the window starts over, so the count goes back to one.')
  await until('q1 passed in the thread', () => lastBody('q1').startsWith('✓ Right.'))
  const a1 = read().questions[0].attempts[0]
  assert.equal(a1.verdict, 'pass'); assert.match(a1.hash, /^[0-9a-f]{12}$/); assert.equal(a1.note, 'Kept and sent again.')
  // The editor stays on the graded question (the feedback is the lesson); the reply box is empty again.
  await sleep(600)
  const codeEd = vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath === path.join(ws, 'api/limits.js'))
  assert.ok(codeEd && codeEd.visibleRanges.some((r) => r.start.line <= 3 && r.end.line >= 6), 'still on q1: its lines in view')
  assert.ok(api.snapshot().notes.find((n: any) => n.id === n1.id)?.threadExpanded, 'q1 open with its grade')
  assert.equal(api.thread(n1.id).state, vscode.CommentThreadState.Unresolved, 'never collapsed as "resolved"')
  const graded = (api.thread(n1.id).comments as vscode.Comment[]).at(-1)!.body as vscode.MarkdownString
  assert.match(graded.value, /^✓ Right\.[\s\S]*\[Next question ›\]\(command:codeNotes\.nextCheckQuestion\)$/)
  if (cdp) {
    const page = await ui()
    const replies = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form .view-lines')].map((e: any) => e.textContent).join('|'))
    assert.ok(!replies.includes('the window starts over'), `the reply box is cleared: ${replies}`)
    await shoot('check-1b-graded')
    await page.locator('.review-widget .comment-body a', { hasText: 'Next question' }).first().click()
  } else await vscode.commands.executeCommand('codeNotes.nextCheckQuestion')
  await until('Next question opens q2', () => inLines(9, 11) && api.snapshot().notes.find((n: any) => n.id === noteOf('q2').id)?.threadExpanded)
  assert.ok(api.thread(n1.id), 'the passed thread stays where it is')
  // A remark on a passed question with markdown in it: shown as typed in the thread (no heading, no rule).
  await answer('q1', '# not a heading\n---\n<b>x</b> [link](https://example.com)')
  await until('the remark shown as typed', () => (api.thread(n1.id).comments as vscode.Comment[]).some((c) => /^\\# not a heading/.test((c.body as vscode.MarkdownString).value) && (c.body as vscode.MarkdownString).value.includes('\\[link\\]') && !(c.body as vscode.MarkdownString).supportHtml))
  ok('a good answer (typed in the reply box): "✓ Right." in the thread, the verdict in the file; the editor stays on q1 with the reply box cleared; "Next question ›" opens q2')

  // 4. A miss: feedback and a hint, the editor stays on the question's lines; the second miss explains; say it back.
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
    await until('after the retry grade: the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && view().answer?.grade && !view().answer.checking)
    await (await ui()).keyboard.type('next try')
    assert.equal(await (await checkFrame()).locator('.answer textarea').inputValue(), 'next try', 'typed after the grade: in the box')
    await (await ui()).keyboard.press('Control+A'); await (await ui()).keyboard.press('Backspace')
  }
  const e = vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath === path.join(ws, 'api/limits.js'))!
  assert.ok(e.selection.isEmpty, `nothing selected: ${JSON.stringify(e.selection)}`); assert.ok(inLines(9, 11), 'on the question')
  assert.ok(e.visibleRanges.some((r) => r.start.line <= 9 && r.end.line >= 11), 'the question\'s lines are in view')
  assert.ok(api.snapshot().notes.find((n: any) => n.id === noteOf('q2').id)?.threadExpanded, 'the thread stays open')
  assert.equal(chk().view.rows[1].word, 'try again')
  // Code links: the hint names the code; a click lights those lines and brings them into view; Back returns to the question.
  const q2n = noteOf('q2'), hintAt = q2n.messages.length - 1
  const linked = await until('the hint carries a code link', () => (api.thread(q2n.id).comments as vscode.Comment[]).find((c) => (c.body as vscode.MarkdownString).value?.includes('command:codeNotes.codeLink')))
  assert.match((linked!.body as vscode.MarkdownString).value, /background-color:var\(--vscode-toolbar-hoverBackground\);">reset /)
  const caret = e.selection
  const limitsText = fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8')
  /** Real keys, as someone answering would type them next: none of it may reach the code. */
  const typeAway = async (what: string) => {
    if (!cdp) return
    const page = await ui()
    await page.keyboard.type('my answer goes here')
    await page.keyboard.press('Enter'); await page.keyboard.press('Backspace')
    await sleep(300)
    assert.equal(fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8'), limitsText, `${what}: the file on disk is untouched`)
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(ws, 'api/limits.js'))
    assert.ok(!doc?.isDirty, `${what}: the code in the editor is untouched`)
    assert.equal(doc?.getText(), limitsText, `${what}: no keystroke in the code`)
  }
  if (cdp) await (await ui()).locator('.review-widget .comment-body a', { hasText: 'reset' }).first().click()
  else await vscode.commands.executeCommand('codeNotes.codeLink', `check|${q2n.id}|${hintAt}`, 0)
  await until('the linked lines lit', () => { const c = api.snapshot().tour.codeLinks; return c.active === 0 && c.at[0]?.start === 10 && c.at[0]?.end === 12 })
  // Only lit: nothing selected, the caret where it was.
  assert.ok(e.selection.isEqual(caret), 'a code link moves no caret and selects nothing')
  await shoot('check-2a-code-link')
  await typeAway('after a code link click')
  await vscode.commands.executeCommand('codeNotes.codeLinkBack')
  await until('back at the question', () => api.snapshot().tour.codeLinks.active === -1 && inLines(9, 11) && api.snapshot().notes.find((n: any) => n.id === q2n.id)?.threadExpanded)
  if (cdp) await until('Back: the keyboard in q2\'s box', async () => { const b = await boxFocused(); if (b !== 'q2') console.log('focus after Back:', b, await (await ui()).evaluate(() => { const a = (globalThis as any).document.activeElement; return `${a?.tagName}.${a?.className}` })); return b === 'q2' })
  await typeAway('after Back')
  if (cdp) {
    // The grade under the box: its code link lights the code and the keyboard stays in the box.
    await until('the grade under the box', () => view().answer?.grade?.hint?.some((p: any) => p.link === 0))
    await shoot('check-2b-box-grade')
    const fr = await checkFrame()
    await fr.locator('.answer .codelink', { hasText: 'the reset function' }).click()
    await until('lit from the view', () => api.snapshot().tour.codeLinks.active === 0)
    await until('the keyboard still in the box', async () => (await boxFocused()) === 'q2')
    await typeAway('after a code link in the view')
    assert.match(view().answer.draft + (await fr.locator('.answer textarea').inputValue()), /my answer goes here/, 'the keys went into the box')
    // The draft survives switching questions.
    await vscode.commands.executeCommand('codeNotes.next')
    await until('on q3', () => view().answer?.id === 'q3')
    await vscode.commands.executeCommand('codeNotes.previous')
    await until('back on q2 with its draft', async () => view().answer?.id === 'q2' && /my answer goes here/.test(view().answer.draft) && (await boxFocused()) === 'q2')
    // Esc: back to the code.
    await (await ui()).keyboard.press('Escape')
    await until('Esc: the editor has the keyboard', async () => (await boxFocused()) === '' && (await (await ui()).evaluate(() => !!(globalThis as any).document.activeElement?.closest?.('.monaco-editor'))))
    ok('the Check view\'s answer box: the keyboard is there on open; Ctrl+Enter answers; its grade\'s code link lights the code and keeps the keyboard; drafts survive switching; Esc goes back to the code')
  }
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
  assert.equal(read().questions[1].attempts[0].answer, undefined)
  // Nor its "Not quite" under it (it would talk about an answer no longer there); the explanation stays.
  await until('the first answer and its retry gone from the thread', () => !noteOf('q2').messages.some((m: any) => m.body === 'Not sure.' || /^Not quite/.test(m.body) || /not kept/.test(m.body)))
  assert.equal(chk().view.rows[1].word, 'explained · say it back')
  if (cdp) {
    await until('after "explained": the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && !view().answer?.checking)
    const page = await ui()
    await page.keyboard.type('GOOD: the counts are per customer, so splitting orders does not help.')
    await page.keyboard.press('Control+Enter')
  } else await answer('q2', 'GOOD: the counts are per customer, so splitting orders does not help.')
  await until('q2 restated', () => lastBody('q2') === '✓ Right.')
  assert.ok(noteOf('q2').messages.some((m: any) => /^It retries with backoff/.test(m.body)), 'the explanation stays after saying it back')
  assert.deepEqual(read().questions[1].attempts.map((a: any) => a.verdict), ['retry', 'explained', 'restated'])
  assert.equal(chk().view.rows[1].word, 'in your words')
  await shoot('check-2-restated')
  ok('a miss keeps the editor on the question (nothing selected, thread open); the hint\'s code link lights the reset function and Back returns; explained; said back rightly: restated, counts as passed')

  // 5. Ctrl+' D goes to the open question; a concern from the grader: Flag for reviewer.
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
  await vscode.commands.executeCommand('codeNotes.next')
  await until('D opens q3', () => codeEditor()?.document.uri.fsPath === path.join(ws, 'api/limits.js') && api.snapshot().notes.find((n: any) => n.id === noteOf('q3').id)?.threadExpanded)
  await answer('q3', 'GOOD CONCERN: they are in memory, so a restart forgets them.')
  await until('q3 passed with a concern', () => chk().view?.rows[2].flag === 'concern')
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'flag')
  await until('flagged in the file', () => read().questions[2].concern?.flagged === true && chk().view.rows[2].flag === 'flagged for review')
  // Add TODO next to the flag: one short line in the code, said in the thread; the flag stays.
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'todo')
  const todo = await until('a TODO in the code', () => { const ls = fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8').split('\n'); const i = ls.findIndex((l) => l.includes('TODO')); return i >= 0 && ls.slice(i, i + 2) })
  // The whole concern (wrapped, nothing cut), at the line's indentation.
  assert.ok(todo.every((l) => l.length <= 100) && todo.map((l) => l.replace(/^\/\/( TODO:)?\s+/, '')).join(' ').includes('a restart lets everyone order again.'), `the whole concern: ${todo.join(' / ')}`)
  await until('said in the thread', () => (api.thread(noteOf('q3').id).comments as vscode.Comment[]).some((c) => /TODO added at limits\.js:1\b/.test((c.body as vscode.MarkdownString).value)))
  assert.equal(read().questions[2].concern?.flagged, true, 'Add TODO keeps the flag')
  ok('Ctrl+\' D opens the open question; the grader\'s concern shows on the row and in the thread; Flag for reviewer is stored in the file; Add TODO keeps it and says where the TODO went')

  // 6. Done: the status bar, the view, Commit & push (to the bare remote).
  await until('done', () => chk().view?.title === '✓ Done' && chk().view.action?.id === 'commitPush' && chk().view.line === 'A new file: not committed yet.')
  await until('status bar done', () => chk().item === '$(pass) Understanding')
  // The button is right under "✓ Done", on screen and clickable, whatever the questions below take.
  const buttonShown = async (label: string) => (await checkFrame()).evaluate((l) => {
    const d = (globalThis as any).document, b = d.querySelector('footer button.primary')
    if (!b || b.textContent !== l) return false
    const r = b.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= (globalThis as any).innerHeight && d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b
  }, label)
  if (cdp) await until('Commit & push on screen, clickable', () => buttonShown('Commit & push'))
  // It names what it commits; the TODO added from the check is offered, not taken; other work is left alone.
  fs.writeFileSync(path.join(ws, 'api', 'scratch.js'), 'export const mine = 1\n')
  // The repository's first check: the line that folds check files in diffs goes with it, said on the same line.
  await until('what it commits', () => chk().view.commits === 'Commits feat-limits.json, also folds check files in diffs (.gitattributes)' && chk().view.also?.[0]?.label === 'also limits.js (TODO added)' && chk().view.also[0].on === false)
  assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')), 'written only on Commit & push')
  await shoot('check-3-done')
  // The status item does what the button does (Commit & push), not a jump to question 1.
  // The remote says how to open a merge request (as GitLab does for a branch without one).
  const remoteDir = git('remote', 'get-url', 'origin')
  fs.writeFileSync(path.join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\necho "To create a merge request for feat/limits, visit:"\necho "  https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits"\n', { mode: 0o755 })
  void vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('pushed', () => chk().view?.line === 'Pushed.' && !chk().view.action, 20000)
  // Said where the person looks: the status bar says what went; the item uses the view's word; the merge request link.
  await until('the merge request link', () => chk().view?.mr === 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Flimits')
  assert.match(chk().itemLabel, /Done\. Pushed\.$/)
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
  ok('done: "✓ Done", Commit & push names and commits exactly the check file and, the first time, the .gitattributes line (the TODO is offered, not taken) and pushes with -u; the view says "Pushed."')

  // 7. The CLI agrees (no model): the committed file passes `ci`.
  const out = execFileSync('node', [path.join(__dirname, '../../../cli/understanding.mjs'), 'ci', '--base', 'main'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.match(out, /^✓ Understanding check done/)
  ok('`ci` passes the committed file without calling a model')


  // 8. Ask Claude on a check question: a note of its own (the check's thread is left alone).
  const before = noteOf('q1').messages.length
  await vscode.commands.executeCommand('codeNotes.askClaude', { thread: api.thread(noteOf('q1').id), text: 'What does counts hold?' })
  const asked = await until('a separate note', () => (api.snapshot().notes as any[]).find((n) => n.messages[0]?.body === 'What does counts hold?'))
  assert.equal(asked.extra?.checkAsk, read().questions[0].text); assert.equal(asked.session, undefined)
  assert.equal(noteOf('q1').messages.length, before)
  assert.ok((api.snapshot().tree() as string[]).some((l) => l.includes('What does counts hold?')), 'a note asked from a question is listed')
  ok('Ask Claude on a check question: a separate note on the same lines, the check thread unchanged')

  // 8b. Suggest a fix on a concern: a note asked to Claude; its reply is one sentence and a suggestion with Apply; Undo works.
  const lim0 = fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8')
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'fix')
  const fixNote = await until('a fix note', () => (api.snapshot().notes as any[]).find((n) => n.extra?.checkFix === 'q3'))
  assert.match(fixNote.messages[0].body, /^Suggest a fix: api\/limits\.js:2 keeps counts in memory/)
  const reply = await until('Claude suggests', () => (api.snapshot().notes as any[]).find((n) => n.id === fixNote.id)?.messages.find((m: any) => m.author === 'Claude'))
  assert.match(reply.body, /^Keep the counts somewhere that survives a restart\.\n\n```suggestion\n/)
  const applyLink = await until('an Apply link', () => (api.thread(fixNote.id)?.comments as vscode.Comment[] | undefined)?.find((c) => /\[Apply suggestion\]\(command:codeNotes\.applySuggestion/.test((c.body as vscode.MarkdownString).value)))
  await shoot('check-6-suggest-fix')
  const args = JSON.parse(decodeURIComponent(/command:codeNotes\.applySuggestion\?([^ )]+)/.exec((applyLink.body as vscode.MarkdownString).value)![1]))
  await vscode.commands.executeCommand('codeNotes.applySuggestion', ...args)
  const limDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(ws, 'api/limits.js'))!
  await until('applied', () => limDoc.getText().startsWith('// FIXED: counts survive a restart\n'))
  // The fix is said on its question and offered (ticked) with Commit & push, although the check file is pushed.
  await until('the applied fix offered', () => view()?.action?.label === 'Commit & push' && view().line === 'Your fix is not committed yet.' && view().rows[2].flag === 'fix applied · not committed' && view().also?.some((x: any) => x.label === 'limits.js (your fix)' && x.on))
  if (cdp) await until('Commit & push on screen with the fix', () => buttonShown('Commit & push'))
  await shoot('check-6b-fix-applied')
  await vscode.window.showTextDocument(limDoc)
  await vscode.commands.executeCommand('undo')
  await until('undone', () => limDoc.getText() === lim0)
  if (limDoc.isDirty) await limDoc.save()
  await until('undone: nothing left to commit', () => view()?.line === 'Pushed.' && !view().action)
  ok('Suggest a fix: a note asked to Claude; one sentence and a suggestion; Apply puts it in ("fix applied · not committed", offered with Commit & push), Undo takes it back')

  // 8c. A concern can be marked fixed (once flagged) or dismissed with a reason: it leaves the thread, the row and the comment.
  assert.ok((api.thread(noteOf('q3').id).comments as vscode.Comment[]).some((c) => /\[Mark fixed\]\(command:codeNotes\.checkConcern[^)]*\) · \[Dismiss\]/.test((c.body as vscode.MarkdownString).value)), 'the quiet actions are there')
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'dismiss', 'A restart is fine: counts are per hour anyway.')
  await until('dismissed', () => read().questions[2].concern?.dismissed?.reason === 'A restart is fine: counts are per hour anyway.' && read().questions[2].concern.flagged === false && !chk().view.rows[2].flag)
  await until('gone from the thread', () => !(api.thread(noteOf('q3').id).comments as vscode.Comment[]).some((c) => /Found while grading/.test(String((c.author as any)?.name))))
  assert.doesNotMatch(execFileSync('node', [path.join(__dirname, '../../../cli/understanding.mjs'), 'ci', '--base', 'main'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH } }), /restart lets everyone/)
  git('commit', '-qam', 'dismissed')
  ok('a concern dismissed with a reason (Dismiss, beside Mark fixed): kept in the file, gone from the thread, the row and the merge request')

  // 9. Drift: 45 new lines (uncommitted) → amber "Needs top-up" before any push.
  const lim = path.join(ws, 'api/limits.js')
  const saved = fs.readFileSync(lim, 'utf8')
  fs.appendFileSync(lim, Array.from({ length: 45 }, (_, i) => `export const MORE_${i} = ${i}`).join('\n') + '\n')
  await vscode.commands.executeCommand('workbench.action.files.revert').then(undefined, () => undefined)
  api.checkRefresh()
  await until('needs top-up', () => /^\$\(warning\) Needs top-up: \+4\d lines$/.test(chk().item) && chk().itemWarn && chk().view.tone === 'warn' && chk().view.action?.id === 'scm')
  await shoot('check-4-drift')
  fs.writeFileSync(lim, saved)
  api.checkRefresh()
  await until('back to done', () => chk().item === '$(pass) Understanding')
  ok('drift from uncommitted lines: amber "Needs top-up: +46 lines" in the status bar and the view (Commit… first)')

  // 10. Another branch: its check threads are hidden (never "file not found"); back: they return.
  git('checkout', '-q', 'main')
  api.checkRefresh()
  await until('check threads hidden on main', () => checkNotes().length === 0 && !api.thread(n1.id))
  // Notes made from the check (Ask Claude on a question, Suggest a fix) belong to the branch too: hidden, never "file not found".
  await until('notes from the check hidden on main', () => !(api.snapshot().notes as any[]).some((n) => n.extra?.checkFix || n.extra?.checkAsk) && !api.thread(asked.id) && !api.thread(fixNote.id))
  assert.equal(asked.extra?.checkFile, 'understanding/feat-limits.json')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('back on the branch', () => checkNotes().length === 3 && (api.snapshot().notes as any[]).filter((n) => n.extra?.checkFix || n.extra?.checkAsk).every((n) => !n.missing))
  ok('on another branch the check\'s threads and the notes made from them are hidden; back on the branch they return')

  // 11. Questions written while the branch is switched: kept, then put in place on return.
  git('checkout', '-q', '-b', 'feat/second')
  fs.appendFileSync(lim, Array.from({ length: 30 }, (_, i) => `export const SECOND_${i} = ${i}`).join('\n') + '\n')
  git('commit', '-qam', 'second')
  api.checkRefresh()
  await until('no check yet on feat/second', () => chk().view?.title === 'No check yet for feat/second')
  const gitDir = path.join(ws, '.git')
  const secondHead = git('rev-parse', 'HEAD')
  // Switched before the writer even starts (Claude takes seconds to get going): everything is still for feat/second.
  fs.writeFileSync(path.join(gitDir, 'fake-slow-start'), '')
  const job = vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('the writer is waiting', () => fs.existsSync(path.join(gitDir, 'fake-slow-start-waiting')), 20000)
  const limitsCheck = fs.readFileSync(path.join(ws, 'understanding/feat-limits.json'), 'utf8')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits\'s view names the other branch', () => /^Writing questions for feat\/second/.test(chk().view?.busy ?? ''))
  fs.rmSync(path.join(gitDir, 'fake-slow-start'))
  await job
  const cached = path.join(ws, '.code-notes/.cache/checks/feat-second.json')
  await until('kept in the cache', () => fs.existsSync(cached) && !fs.existsSync(path.join(ws, 'understanding/feat-second.json')))
  assert.equal(fs.readFileSync(path.join(ws, '.code-notes/.cache/.gitignore'), 'utf8'), '*\n')
  const kept2 = JSON.parse(fs.readFileSync(cached, 'utf8'))
  assert.deepEqual([kept2.branch, kept2.head, kept2.questions.length], ['feat/second', secondHead, 2], 'written for feat/second at its commit, about its own 30 lines (stacked on feat/limits\'s check)')
  // Nothing was written to the branch checked out meanwhile.
  assert.equal(fs.readFileSync(path.join(ws, 'understanding/feat-limits.json'), 'utf8'), limitsCheck, 'feat/limits\'s check untouched')
  assert.equal(git('status', '--porcelain'), '', 'feat/limits: nothing new in the working tree')
  git('checkout', '-q', 'feat/second')
  api.checkRefresh()
  await until('put in place on return', () => fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && !fs.existsSync(cached) && chk().view?.title === '0 of 2 done')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits again', () => chk().item === '$(pass) Understanding')
  // feat/second's unfinished (untracked) check doesn't follow to feat/limits: it waits in the cache for its branch.
  await until('feat/second\'s check parked', () => !fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && fs.existsSync(cached))
  assert.equal(git('status', '--porcelain', '--', 'understanding'), '', 'feat/limits: no other branch\'s check in the tree')
  ok('a branch switch while questions are written: they are written for the branch and commit they were started on, kept in .code-notes/.cache (git-ignored), nothing touches the branch checked out, and they are put in place on return')

  // 12. Someone else answering: one line in the view, nothing blocked.
  git('config', 'user.name', 'Bob'); git('config', 'user.email', 'bob@example.com')
  api.checkRefresh()
  await until('whose check', () => chk().view?.who === "Ada's check: your answers are recorded as yours.")
  git('config', 'user.name', 'Ada'); git('config', 'user.email', 'ada@example.com')
  ok('another git user: "Ada\'s check: your answers are recorded as yours."')

  // 12b. The file rewritten on disk (questions written again, a pull): threads follow; none stands for another question.
  const oldQ2 = (await until('q2\'s thread', () => noteOf('q2'))).id
  const kept = fs.readFileSync(file, 'utf8')
  const rw = read()
  rw.questions[1].text = 'Why does reset() take a customer instead of clearing every count?'; rw.questions[1].attempts = []
  rw.questions.splice(2, 1)
  fs.writeFileSync(file, JSON.stringify(rw, null, 2) + '\n')
  await until('threads follow the rewritten file', () => checkNotes().length === 2 && noteOf('q2')?.id !== oldQ2 && noteOf('q2')?.messages[0].body === rw.questions[1].text && !api.thread(oldQ2))
  fs.writeFileSync(file, kept)
  await until('and back', () => checkNotes().length === 3 && noteOf('q3'))
  ok('the check file rewritten on disk: a changed question gets a new thread, a removed one loses its thread')

  // 12b2. A merge conflict in the check file: said so (not a parser error); Keep both answers merges it.
  const whole = read()
  const theirs = { ...whole, updatedAt: '2026-11-16T09:00:00.000Z' }
  fs.writeFileSync(file, ['<<<<<<< HEAD', JSON.stringify(whole, null, 2), '=======', JSON.stringify(theirs, null, 2), '>>>>>>> pairing', ''].join('\n'))
  await until('the conflict said', () => chk().view?.title === 'The check file has a merge conflict' && chk().view.action?.id === 'merge' && chk().item === '$(warning) Understanding: merge conflict')
  await shoot('check-7-conflict')
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  await until('merged', () => !fs.readFileSync(file, 'utf8').includes('<<<<<<<') && chk().view?.title === '✓ Done' && checkNotes().length === 3)
  fs.writeFileSync(file, kept)
  ok('a merge conflict in the check file: "The check file has a merge conflict", Keep both answers merges it')

  // 12b2b. A file broken by hand: the view names the line; Open puts the caret on it.
  fs.writeFileSync(file, kept.replace('"version": 1,', '"version": 1,,'))
  await until('where it breaks', () => /^Line 2: /.test(chk().view?.line ?? '') && chk().view.action?.id === 'openFile')
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  await until('Open: at the error', () => vscode.window.activeTextEditor?.document.uri.fsPath === file && vscode.window.activeTextEditor.selection.active.line === 1 && vscode.window.activeTextEditor.selection.active.character > 0)
  fs.writeFileSync(file, kept)
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  await until('readable again', () => chk().view?.title === '✓ Done')
  ok('a check file broken by hand: "Line 2: …" in the view, Open puts the caret where it breaks')

  // 12b3. A real merge: a teammate flagged q3's concern, Ada dismissed it (again). Keep both: the flag stays, said;
  // Commit & push concludes the merge and pushes it.
  await until('clean before the merge', () => git('status', '--porcelain', '--', 'understanding/feat-limits.json') === '' && chk().view?.title === '✓ Done')
  git('checkout', '-q', '-b', 'feat/limits-bob')
  const bob = read(); bob.questions[2].concern = { text: bob.questions[2].concern.text, flagged: true }
  fs.writeFileSync(file, JSON.stringify(bob, null, 2) + '\n'); git('commit', '-qam', 'bob flags q3')
  git('checkout', '-q', 'feat/limits')
  const ada = read(); ada.questions[2].concern.dismissed.reason = 'Counts are per hour: a restart is harmless.'
  fs.writeFileSync(file, JSON.stringify(ada, null, 2) + '\n'); git('commit', '-qam', 'ada dismisses q3')
  try { git('merge', '-q', '--no-edit', 'feat/limits-bob') } catch { /* the conflict */ }
  api.checkRefresh()
  await until('the real conflict said', () => chk().view?.action?.id === 'merge')
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  const readSafe = () => { try { return read() } catch { return undefined } }
  await until('kept both, the flag kept and said', () => readSafe()?.questions[2].concern?.flagged === true && /Question 3: its concern stays flagged/.test(view()?.said ?? '') && view().action?.id === 'commitPush')
  if (cdp) await until('Commit & push on screen after the merge', () => buttonShown('Commit & push'))
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  await until('the merge concluded and pushed', () => !fs.existsSync(path.join(ws, '.git', 'MERGE_HEAD')) && git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0] === git('rev-parse', 'HEAD'), 20000)
  ok('a real merge conflict: Keep both keeps the flag a teammate set (said in one line); Commit & push concludes the merge and pushes')

  // 12c. Pushed without a check: the questions are written in the background; nothing opens until clicked.
  git('checkout', '-q', '-b', 'feat/third')
  fs.writeFileSync(path.join(ws, 'api', 'third.js'), 'export const third = 3\n')
  git('add', '-A', 'api/third.js'); git('commit', '-qm', 'third')
  api.checkRefresh()
  await until('no check yet on feat/third', () => chk().view?.title === 'No check yet for feat/third')
  const where = vscode.window.activeTextEditor?.document.uri.fsPath
  // As in real use, VS Code's git has seen the branch before it is pushed.
  await until('git sees feat/third', () => (chk().bg as string[]).includes('feat/third unpushed (new)'), 20000)
  git('push', '-q', '-u', 'origin', 'feat/third')
  await until('questions ready in the background', () => chk().item === '$(checklist) 1 question ready', 40000)
  assert.ok(fs.existsSync(path.join(ws, 'understanding/feat-third.json')))
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, where, 'nothing opened by itself')
  await shoot('check-5-ready')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('a click opens q1', () => codeEditor()?.document.uri.fsPath === path.join(ws, 'api/third.js') && chk().item === '$(checklist) Understanding 0/1')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits once more', () => chk().item === '$(pass) Understanding')
  ok('pushed without a check: questions written in the background, "1 question ready" (stacked: only its own line), nothing opens; a click opens question 1')

  // 13. The tour of the change: written right after the questions, walked in the journey panel with the questions as
  // stops between the steps; a pass stays, Next walks on; rows of the Check view and of the storyline go to their step and question.
  fs.rmSync(path.join(ws, '.git', 'fake-no-tour'), { force: true })
  git('checkout', '-q', '-b', 'feat/tour', 'main')
  git('checkout', 'feat/limits', '--', 'api/limits.js')
  git('commit', '-qm', 'limits for the tour')
  api.checkRefresh()
  await until('no check yet on feat/tour', () => chk().view?.title === 'No check yet for feat/tour')
  const tf = path.join(ws, 'understanding/feat-tour.json')
  const readT = () => JSON.parse(fs.readFileSync(tf, 'utf8'))
  const tourNote = (q: string) => (api.snapshot().notes as any[]).find((n) => n.session === 'Check · feat/tour' && n.extra?.check?.q === q)
  const tour = () => api.snapshot().tour
  // The branch is switched while the tour is written: it stops (nothing written to the other branch) and goes on
  // once the branch is back.
  fs.writeFileSync(path.join(ws, '.git', 'fake-tour-wait'), '')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('q1 opens before the tour is there', () => tourNote('q1')?.threadExpanded)
  await until('the tour is being written', () => fs.existsSync(path.join(ws, '.git', 'fake-tour-wait-waiting')) && chk().view?.tour?.label?.startsWith('Writing the tour'), 20000)
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('switched away: the tour stops, said nowhere on feat/limits', () => !chk().tourBusy && chk().item === '$(pass) Understanding' && !chk().view?.tour?.label?.startsWith('Writing'))
  fs.rmSync(path.join(ws, '.git', 'fake-tour-wait')); fs.rmSync(path.join(ws, '.git', 'fake-tour-wait-waiting'), { force: true })
  assert.equal(fs.readFileSync(path.join(ws, 'understanding/feat-limits.json'), 'utf8').includes('"journey"'), false, 'no tour written into feat/limits\'s check')
  git('checkout', '-q', 'feat/tour')
  api.checkRefresh()
  const t0 = Date.now()
  await until('back: the tour goes on', () => chk().tourBusy || (fs.existsSync(tf) && readT().journey), 20000)
  await until('the tour, right after the questions', () => fs.existsSync(tf) && readT().journey?.steps.length === 6, 30000)
  assert.deepEqual(readT().questions.map((q: any) => q.step), [2, 4, 4])
  await until('rows say their step; the tour link', () => chk().view?.tour?.label === 'Walk the tour · 6 steps' && chk().view.rows.map((r: any) => r.step).join() === '2,4,4')
  assert.ok(!(api.snapshot().journeys as any[]).some((x) => /^check-/.test(x.id)), 'a check\'s tour is not one of the journeys')
  assert.ok(!(api.journeysTree() as string[]).some((l) => /Order limits/.test(l)), 'nor in the Journeys view')
  await shoot('tour-0-check-view')
  ok(`the tour is written right after the questions; a branch switch stops it and it goes on on return (${((Date.now() - t0) / 1000).toFixed(1)} s with the fake): each question after a step; rows say "step n"; not listed as a journey`)

  if (cdp) await clickToast(/The tour of your change is ready/, 'Walk it')
  else api.checkPanelSend({ type: 'test', click: 'button.tour' })
  await until('walking: step 1, the map, 6 steps with the questions between them', () => { const t = tour(); return t.journey === 'check-feat-tour' && t.step === 1 && t.map === 'check-feat-tour' && t.story?.steps === 6 && t.story.stops.join() === 'q1,q2,q3' && !t.story.cur }, 15000)
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('step 2: its card\'s Next is "Question ›"', () => tour().step === 2 && /\[Question ›\]\(command:codeNotes\.nextStep\)/.test(tour().card?.body ?? ''))
  await shoot('tour-1-step')
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('at q1: its thread open, its row the current one', () => { const t = tour(); return t.step === 2 && t.cp === 'q1' && t.story?.cur === 'q1' && tourNote('q1')?.threadExpanded && inLines(3, 7) })
  if (cdp) await until('the keyboard in q1\'s answer box', async () => (await boxFocused()) === 'q1')
  await shoot('tour-2-question')
  await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(tourNote('q1').id), text: 'GOOD: after an hour the count starts again at one.' })
  // A pass keeps the editor on the question (its feedback is the lesson); Next walks on.
  await until('a pass stays on q1', () => tour().step === 2 && tour().cp === 'q1' && /^✓/.test(tourNote('q1').messages.at(-1).body))
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('Next walks on: step 3', () => tour().step === 3 && !tour().cp)
  ok('Walk it: step 1 with the questions as rows between the steps; Next past step 2 opens q1 (keyboard in its answer box; card: "Question ›"); a pass stays, Next walks on to step 3')

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
  await shoot('tour-3-last-step')
  assert.deepEqual(tour().story.overflow, [], 'nothing in the storyline is cut or sticks out')
  ok('rows of the Check view and of the storyline go to their step and question; Next/Previous move between the questions after a step; the last step says "See also: Order and payment, step 3"')

  // Opening the check again walks the tour where it was left; the grader is given the tour.
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('Check my understanding walks the tour', () => tour().journey === 'check-feat-tour' && tour().step === 6 && tour().touring)

  // 13b. A 1280 px window (zoom 0, the sidebar open): the walk keeps 80 columns of code (the step card only, no panel),
  // and "Question ›" opens no panel. A code link in a step card only lights its lines: typing next changes nothing.
  if (cdp) {
    const page = await ui()
    const s = await page.context().newCDPSession(page)
    const zoom = vscode.workspace.getConfiguration('window').inspect<number>('zoomLevel')?.globalValue
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    // The secondary side bar (Chat) closed, as in the reported window: its width is the reader's to give.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global)
    // The window's size as the workbench sees it (Electron has no Browser.setWindowBounds over DevTools).
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await until('a 1280 px window', async () => (await page.evaluate('innerWidth')) === 1280)
    await vscode.commands.executeCommand('codeNotes.check.focus')
    await sleep(500)
    /** The visible columns of each code editor: its text area (after the gutter, before the minimap and scrollbar) in characters. */
    const columns = async (): Promise<number[]> => (await page.evaluate(`(() => {
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
    const was = dump
    dump = () => ({ tour: { ...tour(), story: undefined }, width: 1280 })
    await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
    await until('walking the tour at 1280 px: the step card only', () => tour().journey === 'check-feat-tour' && tour().touring && !!tour().card && !tour().map)
    // Back from the last step to step 3: through the questions after step 4 (each opens its thread, never the panel).
    for (const want of ['5', 'q3', 'q2', '4', '3']) {
      await vscode.commands.executeCommand('codeNotes.previousStep')
      await until(`back to ${want}`, () => (want.startsWith('q') ? tour().cp === want : tour().step === Number(want) && !tour().cp) && !tour().map)
    }
    await until('step 3, its card with the code link "the count"', () => tour().step === 3 && />count<\/span>\]\(command:codeNotes\.codeLink/.test(tour().card?.body ?? '') && !tour().map)
    await sleep(600)
    await shoot('tour-4-1280-step')
    let cols = await columns()
    assert.ok(cols.length && Math.min(...cols) >= 80, `the code keeps 80 columns with the tour open: ${cols}`)
    // The code link, clicked for real; then keys, as someone reading on would type them.
    const limitsNow = fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8')
    await page.locator('.review-widget .comment-body a', { hasText: 'count' }).first().click()
    await until('the link\'s lines lit', () => api.snapshot().tour.codeLinks.active === 0)
    await page.keyboard.type('zz'); await page.keyboard.press('Enter')
    await sleep(400)
    const ldoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(ws, 'api/limits.js'))
    assert.ok(!ldoc?.isDirty && ldoc?.getText() === limitsNow, 'typing after a step\'s code link does not touch the code')
    // "Question ›": the question's thread, still no panel.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 4', () => tour().step === 4 && !tour().cp)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Question ›: q2, no panel', () => tour().cp === 'q2' && tourNote('q2')?.threadExpanded)
    await sleep(800)
    assert.ok(!tour().map, 'a question opens no panel')
    cols = await columns()
    assert.ok(cols.length && Math.min(...cols) >= 80, `the code keeps 80 columns at a question: ${cols}`)
    await shoot('tour-5-1280-question')
    // Hovers and the status item (a Trusted Types error was reported around them): the console is checked at the end.
    await page.locator('.review-widget .comment-body a').first().hover().catch(() => undefined)
    await sleep(800)
    const item = page.locator('.statusbar-item', { hasText: /Understanding/ }).first()
    await item.hover(); await sleep(800); await item.click(); await sleep(800)
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await vscode.workspace.getConfiguration('window').update('zoomLevel', zoom, vscode.ConfigurationTarget.Global)
    await s.send('Emulation.clearDeviceMetricsOverride')
    dump = was
    await sleep(500)
    ok(`a 1280 px window: the tour walks with the step card only (${Math.min(...cols)} columns of code), "Question ›" opens no panel; typing after a step's code link changes nothing`)
  }
  await vscode.commands.executeCommand('codeNotes.endJourney')
  // Nothing of feat/limits' .gitattributes may be left untracked here before the checkout (force: usually none).
  for (const f of ['.gitattributes', '.ignore']) fs.rmSync(path.join(ws, f), { force: true })
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits: no tour of feat/tour shown', () => chk().item === '$(pass) Understanding' && !(api.snapshot().tour.journey ?? '').startsWith('check-feat-tour'))
  ok('Check my understanding walks the tour from where it was left; another branch: that tour is gone')

  // 14. Finding journeys (journeyList.ts): "In this file" follows the editor; search reads step text.
  const tree = () => api.journeysTree() as string[]
  const j = JSON.parse(fs.readFileSync(path.join(ws, 'journeys/place-order.json'), 'utf8'))
  const stepFile = j.steps[0].file as string
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, stepFile)))
  await until('"In this file" for a file a step is in', () => tree()[0] === 'jgroup:In this file · 1' && /journey:/.test(tree()[1]))
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
  await until('no "In this file" for a file no step is in', () => !tree().some((l) => l.startsWith('jgroup:In this file')))
  const words = (t: string) => t.toLowerCase().match(/[a-z]{5,}/g) ?? []
  const own = new Set([...words(j.title), ...words(j.question), ...words(j.summary ?? '')])
  const word = j.steps.flatMap((x: any) => words(x.title)).find((w: string) => !own.has(w))
  assert.ok(word, 'a word only a step title has')
  const found = api.journeyList({ query: word })
  assert.ok(found.sections[0].keys.some((k: string) => found.rows[k].title === j.title), `"${word}" finds "${j.title}" by a step's title`)
  await vscode.commands.executeCommand('codeNotes.journeys.focus')
  await sleep(600)
  shot('journeys-sidebar')
  ok(`Journeys view: "In this file" follows the editor; the search finds "${word}" in a step's title`)

  // 15. The view never showed an error or anything wider than itself.
  const p = chk().panel
  assert.deepEqual(p.errors, []); assert.deepEqual(p.overflow, [])
  ok('Check view: no errors, nothing cut or sticking out')
  // 16. Refreshing costs nothing when nothing changed, and never stops the extension host.
  await until('settled on feat/limits', () => chk().item === '$(pass) Understanding')
  await api.checkRefresh()
  await sleep(1500)
  const r0 = chk().refreshes
  // `git status` (VS Code's Git view, a terminal, an agent) rewrites .git/index: nothing the check shows changed.
  for (let k = 0; k < 5; k++) git('status')
  await sleep(2000)
  assert.equal(chk().refreshes.full, r0.full, `git status refreshed the check: ${JSON.stringify([r0, chk().refreshes])}`)
  // A burst of triggers (focus, saves, the Git view): one check of the key, plus at most one more; nothing read again.
  const r1 = chk().refreshes
  await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh(false)))
  const r2 = chk().refreshes
  assert.equal(r2.full, r1.full, 'nothing changed: no full refresh')
  assert.ok(r2.same - r1.same <= 2, `coalesced: ${r2.same - r1.same} checks for 10 triggers`)
  // Ten asked for at once while one runs: two refreshes, not ten.
  await Promise.all(Array.from({ length: 10 }, () => api.checkRefresh()))
  assert.ok(chk().refreshes.full - r2.full <= 2, `coalesced: ${chk().refreshes.full - r2.full} refreshes for 10 calls`)
  // A change does go through: a commit (HEAD moves), seen without being asked.
  const r3 = chk().refreshes
  fs.writeFileSync(path.join(ws, 'api', 'gate.js'), 'export const gate = 1\n')
  git('add', 'api/gate.js'); git('commit', '-qm', 'gate')
  await until('the commit refreshed the check', () => chk().refreshes.full > r3.full && chk().status?.head === git('rev-parse', 'HEAD'))
  // With git taking 0.25 s a call, a refresh takes seconds; the extension host's event loop never waits on it.
  const pathWas = process.env.PATH
  process.env.PATH = `${process.env.CODE_NOTES_SLOW_GIT}${path.delimiter}${pathWas}`
  api.checkRestartWorker() // its git: the slow one first on PATH
  fs.writeFileSync(path.join(ws, '.git', 'slow-git'), '')
  let worst = 0, last = Date.now()
  const tick = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last - 10); last = t }, 10)
  const tSlow = Date.now()
  try { await api.checkRefresh() } finally {
    clearInterval(tick); fs.rmSync(path.join(ws, '.git', 'slow-git'))
    process.env.PATH = pathWas; api.checkRestartWorker()
  }
  const took = Date.now() - tSlow
  assert.ok(took > 1500, `git was slow (${took} ms)`)
  assert.ok(worst < 30 * SCALE, `the extension host waited ${worst} ms during a ${took} ms refresh`)
  ok(`refresh: git status refreshes nothing, triggers coalesce, a commit goes through; a ${took} ms refresh held the event loop ${worst} ms at most`)

  // 17. Opening a question: calls into the window (each a round trip over a remote link).
  const c = callCounter(api)
  try {
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
    await sleep(500)
    const r = await c.measure('opening a question', () => api.checkOpenQuestion('q1'), () => inLines(3, 6) && /limits\.js$/.test(codeEditor()?.document.uri.path ?? ''))
    assert.ok(r.calls.filter((x) => x.startsWith('show')).length <= 1 && r.calls.length <= 3, `opening a question: ${r.calls.join(', ')}`)
  } finally { c.dispose() }
  ok('opening a question: one show, few calls into the window')
}
