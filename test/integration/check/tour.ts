// Questions written in the background for a pushed branch, then the tour of the change: written right after the
// questions, walked in the journey panel with the questions as stops between the steps; a pass stays, Next walks on;
// rows of the Check view and of the storyline go to their step and question; at 1280 px the step card only.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { quiet, settle, test, untilEqual } from '../helpers'
import { boxFocused, cdp, clickToast, codeColumns, pageShot, ui } from '../devtools'
import { CHECK_WAIT_MS, api, checkFile, chk, codeEditor, devtools, dumpState, git, inLines, limitsPath, readTour, setDumpState, tour, tourFile, tourNote, until, view, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const tourTests = [
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
    setDumpState(() => ({ tour: { ...tour(), story: undefined }, width: 1280 }))
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
    setDumpState(dumpBefore)
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
]
