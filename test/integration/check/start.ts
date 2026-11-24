// Starting a check: no check yet, Start (Claude failing first, Retry, uncommitted work named), question 1 opened with
// the keyboard in its answer box; at 1280×800 the Check view fits all three questions.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { settle, test } from '../helpers'
import { boxFocused, checkFrame, focusedElement, pageShot, ui } from '../devtools'
import { api, checkFile, checkNotes, chk, devtools, git, inLines, left, limitsPath, noteById, noteOf, readCheck, until, view, ws } from './context'
import { setFakeScenario } from './fakeGrader'
import { clickInCheckView, withWindowSize } from './support'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Work left uncommitted when Start runs: a new file and a change to a tracked one. */
const uncommitted = path.join(ws, 'api', 'allowlist.js')

export const startTests = [
  test('no check yet: "Understanding: start" in the status bar; "No check yet for feat/limits" and Start in the Check view', async () => {
    await until('status bar offers a check', () => chk()?.item === '$(checklist) Understanding: start')
    await vscode.commands.executeCommand('codeNotes.check.focus')
    await until('the view says there is no check yet', () => view()?.title === 'No check yet for feat/limits' && view().action?.id === 'start' && chk().panel.rows === 0)
  }),

  test('Claude fails first (a model that doesn\'t exist): said in the view in plain words, with Retry; no toast', async () => {
    setFakeScenario({ writeError: true })
    try {
      await vscode.commands.executeCommand('codeNotes.checkUnderstanding')
      await until('the failure in the view', () => view()?.failed?.text === "Claude couldn't use the model." && view().failed!.setting === true && !view().action)
      await pageShot('check-0-failed')
    } finally { setFakeScenario({ writeError: undefined }) }
  }),

  test('Retry starts the check; uncommitted work doesn\'t stop it: one line in the view names every file left out (modified ones too), none is asked about', async () => {
    fs.writeFileSync(uncommitted, 'export const allow = []\n')
    fs.appendFileSync(path.join(ws, 'README.md'), '\nMore.\n')
    try {
      await clickInCheckView('.failed button.link', 'Retry')
      await until('three question threads', () => checkNotes().length === 3)
      await until('Retry worked: the failure is gone', () => !view().failed)
      await until('what was left out', () => view().notice === 'Not asked about (uncommitted): README.md, allowlist.js')
      await pageShot('check-0-uncommitted')
    } finally {
      fs.rmSync(uncommitted, { force: true }); git('checkout', '--', 'README.md')
    }
    assert.ok(readCheck().questions.every((q: any) => q.file === 'api/limits.js'), 'questions only about the committed change')
  }),

  test('Start writes the questions at HEAD; only question 1 opens (its code and its thread, one editor group); the list is the Check view, not the Code Notes tree', async () => {
    const written = readCheck()
    assert.deepEqual(written.questions.map((q: any) => q.kind), ['failure', 'why', 'edge'])
    assert.equal(written.head, git('rev-parse', 'HEAD'))
    left.q1Note = noteOf('q1')
    assert.deepEqual([left.q1Note.file, left.q1Note.range.start, left.q1Note.range.end], ['api/limits.js', 4, 7])
    assert.match(api.thread(left.q1Note.id)!.contextValue!, /check/)
    await until('q1\'s code on screen', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === limitsPath))
    await until('q1 open on its lines', () => noteById(left.q1Note.id)?.threadExpanded && inLines(3, 6))
    assert.equal(vscode.window.tabGroups.all.length, 1, 'one editor group')
    assert.ok(!(api.snapshot().tree() as string[]).some((l) => /What does allow\(\)|per customer rather|API process restarts/.test(l)), 'no check rows in the Code Notes tree')
    await until('q1 selected: its answer box', () => view()?.answer?.id === 'q1' && view().answer!.open)
  }),

  test('the keyboard is in q1\'s answer box on open, not in the code; a draft is kept in the workspace; VS Code\'s shortcuts work from the box', async () => {
    // Typing in the code would edit limits.js.
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
    // Ctrl+G (Go to Line) from the box, leaving nothing in it.
    await page.keyboard.press('Control+G')
    await until('Go to Line opened from the box', () => page.locator('.quick-input-widget').isVisible())
    await page.keyboard.press('Escape')
    assert.equal(await (await checkFrame()).locator('.answer textarea').inputValue(), '', 'nothing typed into the box')
  }, devtools),

  test('the view lists three questions, the status bar says 0/3 in words; nothing written to the repository or the settings by itself', async () => {
    await until('the view lists three questions', () => chk().panel.rows === 3 && view().title === '0 of 3 done' && view().line === 'Answer all 3 · 2 must pass · ~2 min left.')
    await until('status bar 0/3', () => chk().item === '$(checklist) Understanding 0/3')
    assert.match(chk().itemLabel ?? '', /^Understanding check: 0 of 3 done\. Answer all 3/, 'read out as words, never an icon id')
    // Untracked setup files once blocked a checkout. The first Commit & push of a check takes the .gitattributes line along.
    assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')) && !fs.existsSync(path.join(ws, '.ignore')), 'no setup files by themselves')
    assert.equal(vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude')?.['understanding/**'], undefined, 'no search.exclude written')
    assert.equal((view() as any).setup, undefined, 'no separate setup offer')
    await pageShot('check-1-questions')
  }),

  test('1280×800, no notes: the Code Notes view steps aside; the Check view shows all 3 questions and the answer box', async () => {
    // No zoom; nothing may need scrolling.
    const fit = await withWindowSize(1280, 800, async (page) => {
      await until('the empty Code Notes view steps aside', async () => !(await page.locator('.pane-header h3.title', { hasText: /^Code Notes$/ }).count()))
      const m = await until('the Check view laid out', async () => {
        await settle(300, 'the view lays itself out at the new size before it is measured')
        const frame = await checkFrame()
        const got = await frame.evaluate(() => { const d = (globalThis as any).document, h = (globalThis as any).innerHeight; const rows = [...d.querySelectorAll('.row')]; return { h, scroll: d.documentElement.scrollHeight, rows: rows.length, cut: rows.map((r: any) => r.getBoundingClientRect().bottom).filter((b: number) => b > h + 1).length, box: !!d.querySelector('.answer textarea') } })
        return got.rows === 3 && got.box && got
      })
      await pageShot('check-1-fits')
      return m
    })
    assert.ok(fit.cut === 0 && fit.scroll <= fit.h + 1, `all questions visible without scrolling: ${JSON.stringify(fit)}`)
    return `${fit.scroll} of ${fit.h} px`
  }, devtools),
]
