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
  dump = () => ({ check: chk(), files: fs.readdirSync(ws), u: fs.existsSync(path.join(ws, 'understanding')) && fs.readdirSync(path.join(ws, 'understanding')), notes: api.snapshot().notes.map((n: any) => [n.session, n.extra]) })
  const shot = (name: string) => { const d = process.env.CODE_NOTES_SHOTS; if (d) execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)]) }

  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../test/fixtures/fake-grader.js'), vscode.ConfigurationTarget.Workspace)
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
  const editorLine = () => vscode.window.activeTextEditor?.selection.active.line
  const inLines = (a: number, b: number) => { const l = editorLine(); return l !== undefined && l >= a && l <= b }

  // 1. A branch with a change and no check: the status bar says so; so does the Check view.
  await until('status bar offers a check', () => chk()?.item === '$(checklist) Understanding: start')
  await vscode.commands.executeCommand('codeNotes.check.focus')
  await until('the view says there is no check yet', () => view()?.title === 'No check yet for feat/limits' && view().action?.id === 'start' && chk().panel.rows === 0)
  ok('no check yet: "Understanding: start" in the status bar; "No check yet for feat/limits" and Start in the Check view')

  // 2. Uncommitted work doesn't stop the start: one line in the view names every file left out (modified ones too).
  fs.writeFileSync(path.join(ws, 'api', 'allowlist.js'), 'export const allow = []\n')
  fs.appendFileSync(path.join(ws, 'README.md'), '\nMore.\n')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('three question threads', () => checkNotes().length === 3)
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
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(ws, 'api/limits.js'))
  await until('q1 open on its lines', () => api.snapshot().notes.find((n: any) => n.id === n1.id)?.threadExpanded && inLines(3, 6))
  assert.equal(vscode.window.tabGroups.all.length, 1, 'one editor group')
  // One list of the questions: the Check view; the Code Notes tree doesn't repeat them.
  assert.ok(!(api.snapshot().tree() as string[]).some((l) => /What does allow\(\)|per customer rather|API process restarts/.test(l)), 'no check rows in the Code Notes tree')
  await until('q1 selected: its answer box', () => view()?.answer?.id === 'q1' && view().answer.open)
  if (cdp) {
    // The keyboard is in q1's answer box in the Check view, not in the code (typing there would edit limits.js).
    const page = await ui()
    await until('focus in the answer box, not the code', async () => (await boxFocused()) === 'q1')
    await page.keyboard.type('typed')
    assert.equal(fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8').includes('typed'), false)
    assert.ok(!vscode.window.activeTextEditor?.document.isDirty, 'the code is untouched')
    // An unsent answer is kept (this workspace, not the file).
    await until('the draft kept', () => view().answer?.draft === 'typed')
    assert.ok(!fs.readFileSync(file, 'utf8').includes('typed'))
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace')
    await until('the draft gone', () => view().answer?.draft === '')
  }
  await until('the view lists three questions', () => chk().panel.rows === 3 && view().title === '0 of 3 done' && view().line === 'Answer all 3 · 2 must pass.')
  await until('status bar 0/3', () => chk().item === '$(checklist) Understanding 0/3')
  // Quietly: .gitattributes and .ignore for check files; nothing in the workspace's settings.
  await until('repository lines', () => fs.existsSync(path.join(ws, '.gitattributes')) && fs.readFileSync(path.join(ws, '.gitattributes'), 'utf8') === 'understanding/*.json gitlab-generated linguist-generated\n' && fs.readFileSync(path.join(ws, '.ignore'), 'utf8') === 'understanding/\n')
  assert.equal(vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude')?.['understanding/**'], undefined, 'no search.exclude written')
  await shoot('check-1-questions')
  if (cdp) {
    // VS Code's own search skips the check file because of .ignore (search.useIgnoreFiles, on by default).
    const probe = path.join(ws, 'api', 'search-probe.txt')
    fs.writeFileSync(probe, 'already expired\n')
    await vscode.commands.executeCommand('workbench.action.findInFiles', { query: 'already expired', triggerSearch: true, isRegex: false, filesToInclude: '', filesToExclude: '' })
    const page = await ui()
    const rows = await until('search results', async () => { const r: string[] = await page.$$eval('.search-view .monaco-list-row', (els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? '')); return r.some((x) => /search-probe/.test(x)) && r })
    assert.ok(!rows.some((r) => /feat-limits/.test(r)), `the check file is not in the search results: ${rows.join(' | ')}`)
    assert.ok(read().questions.some((q: any) => q.text.includes('already expired')), 'the check file does hold the words')
    fs.rmSync(probe)
    await vscode.commands.executeCommand('codeNotes.check.focus')
    ok('VS Code search leaves the check file out (.ignore), with no workspace setting')
  }
  ok('Start: no question asked about uncommitted work (the view names it); only question 1 opens (code + thread); the list is the Check view; .gitattributes and .ignore set quietly')

  const answer = async (q: string, text: string) => {
    const n = noteOf(q)
    await vscode.commands.executeCommand('codeNotes.answerCheck', { thread: api.thread(n.id), text })
  }
  const lastBody = (q: string) => { const m = noteOf(q).messages; return m[m.length - 1].body as string }

  // 3. A good answer typed in the real reply box: ✓ in the thread, the verdict in the file; on to question 2.
  if (cdp) {
    const page = await ui()
    await page.locator('.statusbar-item[aria-label*="Understanding 0/3"]').first().click()
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
  const e = vscode.window.activeTextEditor!
  assert.ok(e.selection.isEmpty, 'nothing selected'); assert.ok(inLines(9, 11), 'on the question')
  assert.ok(e.visibleRanges.some((r) => r.start.line <= 9 && r.end.line >= 11), 'the question\'s lines are in view')
  assert.ok(api.snapshot().notes.find((n: any) => n.id === noteOf('q2').id)?.threadExpanded, 'the thread stays open')
  assert.equal(chk().view.rows[1].word, 'try again')
  // Code links: the hint names the code; a click lights those lines and brings them into view; Back returns to the question.
  const q2n = noteOf('q2'), hintAt = q2n.messages.length - 1
  const linked = await until('the hint carries a code link', () => (api.thread(q2n.id).comments as vscode.Comment[]).find((c) => (c.body as vscode.MarkdownString).value?.includes('command:codeNotes.codeLink')))
  assert.match((linked!.body as vscode.MarkdownString).value, /background-color:var\(--vscode-toolbar-hoverBackground\);">reset /)
  const caret = vscode.window.activeTextEditor!.selection
  const limitsText = fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8')
  /** Real keys, as someone answering would type them next: none of it may reach the code. */
  const typeAway = async (what: string) => {
    if (!cdp) return
    const page = await ui()
    await page.keyboard.type('my answer goes here')
    await page.keyboard.press('Enter'); await page.keyboard.press('Backspace')
    await sleep(300)
    assert.equal(fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8'), limitsText, `${what}: the file on disk is untouched`)
    assert.ok(!vscode.window.activeTextEditor?.document.isDirty, `${what}: the code in the editor is untouched`)
    assert.equal(vscode.window.activeTextEditor?.document.getText(), limitsText, `${what}: no keystroke in the code`)
  }
  if (cdp) await (await ui()).locator('.review-widget .comment-body a', { hasText: 'reset' }).first().click()
  else await vscode.commands.executeCommand('codeNotes.codeLink', `check|${q2n.id}|${hintAt}`, 0)
  await until('the linked lines lit', () => { const c = api.snapshot().tour.codeLinks; return c.active === 0 && c.at[0]?.start === 10 && c.at[0]?.end === 12 })
  // Only lit: nothing selected, the caret where it was.
  assert.ok(vscode.window.activeTextEditor!.selection.isEqual(caret), 'a code link moves no caret and selects nothing')
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
  await answer('q2', 'Still not sure.')
  await until('q2 explained', () => /Got it\? Say it back in one sentence/.test(lastBody('q2')))
  // The first wrong answer is not kept: not in the file, not in the note.
  assert.equal(read().questions[1].attempts[0].answer, undefined)
  assert.equal(noteOf('q2').messages.filter((m: any) => m.role === 'human')[0].body, '_An earlier answer (not kept)._')
  assert.equal(chk().view.rows[1].word, 'explained · say it back')
  await answer('q2', 'GOOD: the counts are per customer, so splitting orders does not help.')
  await until('q2 restated', () => lastBody('q2') === '✓ Right.')
  assert.deepEqual(read().questions[1].attempts.map((a: any) => a.verdict), ['retry', 'explained', 'restated'])
  assert.equal(chk().view.rows[1].word, 'in your words')
  await shoot('check-2-restated')
  ok('a miss keeps the editor on the question (nothing selected, thread open); the hint\'s code link lights the reset function and Back returns; explained; said back rightly: restated, counts as passed')

  // 5. Ctrl+' D goes to the open question; a concern from the grader: Flag for reviewer.
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'README.md')))
  await vscode.commands.executeCommand('codeNotes.next')
  await until('D opens q3', () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(ws, 'api/limits.js') && api.snapshot().notes.find((n: any) => n.id === noteOf('q3').id)?.threadExpanded)
  await answer('q3', 'GOOD CONCERN: they are in memory, so a restart forgets them.')
  await until('q3 passed with a concern', () => chk().view?.rows[2].flag === 'concern')
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'flag')
  await until('flagged in the file', () => read().questions[2].concern?.flagged === true && chk().view.rows[2].flag === 'flagged for review')
  // Add TODO next to the flag: one short line in the code, said in the thread; the flag stays.
  await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'todo')
  const todo = await until('a TODO in the code', () => fs.readFileSync(path.join(ws, 'api/limits.js'), 'utf8').split('\n').find((l) => l.includes('TODO')))
  assert.ok(todo.length <= 80, `a short TODO: ${todo}`)
  await until('said in the thread', () => (api.thread(noteOf('q3').id).comments as vscode.Comment[]).some((c) => /TODO added at limits\.js:1\b/.test((c.body as vscode.MarkdownString).value)))
  assert.equal(read().questions[2].concern?.flagged, true, 'Add TODO keeps the flag')
  ok('Ctrl+\' D opens the open question; the grader\'s concern shows on the row and in the thread; Flag for reviewer is stored in the file; Add TODO keeps it and says where the TODO went')

  // 6. Done: the status bar, the view, Commit & push (to the bare remote).
  await until('done', () => chk().view?.title === '✓ Done' && chk().view.action?.id === 'commitPush')
  await until('status bar done', () => chk().item === '$(pass) Understanding')
  // It names what it commits; the TODO added from the check is offered, not taken; other work is left alone.
  fs.writeFileSync(path.join(ws, 'api', 'scratch.js'), 'export const mine = 1\n')
  await until('what it commits', () => chk().view.commits === 'Commits feat-limits.json, .gitattributes, .ignore' && chk().view.also?.[0]?.label === 'also limits.js (TODO added)' && chk().view.also[0].on === false)
  await shoot('check-3-done')
  api.checkPanelSend({ type: 'test', click: 'footer button.primary' })
  await until('pushed', () => chk().view?.line === 'Pushed.' && !chk().view.action, 20000)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/feat/limits').split('\t')[0], git('rev-parse', 'HEAD'))
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitattributes', '.ignore', 'understanding/feat-limits.json'])
  assert.deepEqual(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? api/scratch.js', 'M api/limits.js'], 'the TODO and other work are left alone')
  fs.rmSync(path.join(ws, 'api', 'scratch.js')); git('checkout', '--', 'api/limits.js')
  ok('done: "✓ Done", Commit & push names and commits exactly the check file, .gitattributes and .ignore (the TODO is offered, not taken) and pushes with -u; the view says "Pushed."')

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
  await vscode.window.showTextDocument(limDoc)
  await vscode.commands.executeCommand('undo')
  await until('undone', () => limDoc.getText() === lim0)
  if (limDoc.isDirty) await limDoc.save()
  ok('Suggest a fix: a note asked to Claude; one sentence and a suggestion; Apply puts it in, Undo takes it back')

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
  fs.writeFileSync(path.join(gitDir, 'fake-slow'), '')
  const job = vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('the writer is waiting', () => fs.existsSync(path.join(gitDir, 'fake-slow-waiting')), 20000)
  git('checkout', '-q', 'feat/limits')
  fs.rmSync(path.join(gitDir, 'fake-slow'))
  await job
  const cached = path.join(ws, '.code-notes/.cache/checks/feat-second.json')
  await until('kept in the cache', () => fs.existsSync(cached) && !fs.existsSync(path.join(ws, 'understanding/feat-second.json')))
  assert.equal(fs.readFileSync(path.join(ws, '.code-notes/.cache/.gitignore'), 'utf8'), '*\n')
  git('checkout', '-q', 'feat/second')
  api.checkRefresh()
  await until('put in place on return', () => fs.existsSync(path.join(ws, 'understanding/feat-second.json')) && !fs.existsSync(cached) && chk().view?.title === '0 of 3 done')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits again', () => chk().item === '$(pass) Understanding')
  ok('questions finished after a branch switch wait in .code-notes/.cache (git-ignored) and are put in place on return')

  // 12. Someone else answering: one line in the view, nothing blocked.
  git('config', 'user.name', 'Bob'); git('config', 'user.email', 'bob@example.com')
  api.checkRefresh()
  await until('whose check', () => chk().view?.who === "Ada's check: your answers are recorded as yours.")
  git('config', 'user.name', 'Ada'); git('config', 'user.email', 'ada@example.com')
  ok('another git user: "Ada\'s check: your answers are recorded as yours."')

  // 12b. The file rewritten on disk (questions written again, a pull): threads follow; none stands for another question.
  const oldQ2 = noteOf('q2').id
  const kept = fs.readFileSync(file, 'utf8')
  const rw = read()
  rw.questions[1].text = 'Why does reset() take a customer instead of clearing every count?'; rw.questions[1].attempts = []
  rw.questions.splice(2, 1)
  fs.writeFileSync(file, JSON.stringify(rw, null, 2) + '\n')
  await until('threads follow the rewritten file', () => checkNotes().length === 2 && noteOf('q2')?.id !== oldQ2 && noteOf('q2')?.messages[0].body === rw.questions[1].text && !api.thread(oldQ2))
  fs.writeFileSync(file, kept)
  await until('and back', () => checkNotes().length === 3 && noteOf('q3'))
  ok('the check file rewritten on disk: a changed question gets a new thread, a removed one loses its thread')

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
  await until('questions ready in the background', () => chk().item === '$(checklist) 3 questions ready', 40000)
  assert.ok(fs.existsSync(path.join(ws, 'understanding/feat-third.json')))
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, where, 'nothing opened by itself')
  await shoot('check-5-ready')
  await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
  await until('a click opens q1', () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(ws, 'api/limits.js') && chk().item === '$(checklist) Understanding 0/3')
  git('checkout', '-q', 'feat/limits')
  api.checkRefresh()
  await until('feat/limits once more', () => chk().item === '$(pass) Understanding')
  ok('pushed without a check: questions written in the background, "3 questions ready", nothing opens; a click opens question 1')

  // 13. Finding journeys (journeyList.ts): "In this file" follows the editor; search reads step text.
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

  // 14. The view never showed an error or anything wider than itself.
  const p = chk().panel
  assert.deepEqual(p.errors, []); assert.deepEqual(p.overflow, [])
  ok('Check view: no errors, nothing cut or sticking out')
}
