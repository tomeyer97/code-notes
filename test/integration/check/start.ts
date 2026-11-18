// Starting a check: no check yet, Start (Claude failing first, Retry, uncommitted work named), question 1 opened with
// the keyboard in its answer box; at 1280×800 the Check view fits all three questions.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { settle, test } from '../helpers'
import { boxFocused, cdp, checkFrame, focusedElement, pageShot, ui } from '../devtools'
import { api, checkFile, checkNotes, chk, devtools, git, inLines, left, limitsPath, noteById, noteOf, readCheck, until, view, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const startTests = [
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
    left.q1Note = noteOf('q1')
    assert.deepEqual([left.q1Note.file, left.q1Note.range.start, left.q1Note.range.end], ['api/limits.js', 4, 7])
    assert.match(api.thread(left.q1Note.id)!.contextValue!, /check/)
    // Only question 1 opens: its code and its thread. No editor group for a list: it is in the sidebar.
    await until('q1\'s code on screen', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === limitsPath))
    await until('q1 open on its lines', () => noteById(left.q1Note.id)?.threadExpanded && inLines(3, 6))
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
]
