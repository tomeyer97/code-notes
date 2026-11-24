// Answering: a good answer typed in the thread's reply box, a miss with a hint and its code link, the Check view's
// answer box (keyboard, drafts, Esc), explained and said back, the grader's concern (flag, TODO).
// Where a step can be done with real input (DevTools) or with the command it runs, there are two tests: the
// `devtools` one and its `withoutDevtools` stand-in; the test after them checks what both lead to.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { quiet, settle, test, untilEqual } from '../helpers'
import { boxFocused, checkFrame, focusedElement, pageShot, ui } from '../devtools'
import { CHECK_WAIT_MS, api, answer, codeEditor, commentBody, devtools, inLines, lastBody, left, limitsEditor, limitsPath, noteById, noteOf, readCheck, threadComments, typeAnswer, until, view, ws } from './context'
import { linksOf, withoutDevtools } from './support'

/* eslint-disable @typescript-eslint/no-explicit-any */

const GOOD_Q1 = 'GOOD: the window starts over, so the count goes back to one.'
const GOOD_Q2 = 'GOOD: the counts are per customer, so splitting orders does not help.'

/** Real keys, as someone answering would type them next: none of it may reach the code, which stays `expected`. */
async function typeAway(what: string, expected: string): Promise<void> {
  const page = await ui()
  await page.keyboard.type('my answer goes here')
  await page.keyboard.press('Enter'); await page.keyboard.press('Backspace')
  await quiet(300, 'a keystroke reaching the code')
  assert.equal(fs.readFileSync(limitsPath, 'utf8'), expected, `${what}: the file on disk is untouched`)
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === limitsPath)
  assert.ok(!doc?.isDirty, `${what}: the code in the editor is untouched`)
  assert.equal(doc?.getText(), expected, `${what}: no keystroke in the code`)
}

/** The code link in q2's hint (the reset function): the note, the hint's message index, its comment. */
async function q2HintLink() {
  const q2 = noteOf('q2')
  const comment = await until('the hint carries a code link', () => threadComments(q2.id).find((c) => linksOf(c).some((l) => l.command === 'codeNotes.codeLink')))
  return { q2, hintAt: q2.messages.length - 1, link: linksOf(comment).find((l) => l.command === 'codeNotes.codeLink')! }
}

/** Lights the hint's code link with `click`: the lines 10-12 lit, nothing selected, the caret where it was. */
async function lightHintLink(click: (hint: Awaited<ReturnType<typeof q2HintLink>>) => Promise<unknown>): Promise<void> {
  const hint = await q2HintLink()
  const editor = limitsEditor()!
  const caret = editor.selection
  await click(hint)
  await until('the linked lines lit', () => api.snapshot().tour.codeLinks.active === 0)
  await untilEqual('the linked lines', () => { const at = api.snapshot().tour.codeLinks.at[0]; return [at?.start, at?.end] }, [10, 12], CHECK_WAIT_MS)
  assert.ok(editor.selection.isEqual(caret), 'a code link moves no caret and selects nothing')
}

export const answersTests = [
  test('q1 answered in its thread\'s reply box: the status item opens it, real keys, the Answer button', async () => {
    const page = await ui()
    await page.locator('.statusbar-item[aria-label*="Understanding check: 0 of 3 done"]').first().click()
    await settle(800, 'the status item opens q1 and its thread widget')
    await page.locator('.review-widget .review-thread-reply-button').first().click()
    await until('the keyboard in the thread\'s reply box', () => page.evaluate(() => !!(globalThis as any).document.activeElement?.closest?.('.review-widget .comment-form')))
    await page.keyboard.type(GOOD_Q1)
    await page.locator('.review-widget .monaco-button', { hasText: 'Answer' }).first().click()
  }, devtools),

  test('q1 answered through its thread\'s reply (the Answer command)', async () => {
    await answer('q1', GOOD_Q1)
  }, withoutDevtools),

  test('a good answer: "✓ Right." in the thread with "Next question ›" under it, the verdict in the file; the editor stays on q1', async () => {
    await until('q1 passed in the thread', () => lastBody('q1').startsWith('✓ Right.'))
    const attempt = readCheck().questions[0].attempts[0]
    assert.equal(attempt.verdict, 'pass'); assert.match(attempt.hash, /^[0-9a-f]{12}$/); assert.equal(attempt.note, 'Kept and sent again.')
    // The editor stays on the graded question (the feedback is the lesson).
    await quiet(600, 'the editor moving off the graded question')
    const codeEd = limitsEditor()
    assert.ok(codeEd && codeEd.visibleRanges.some((r) => r.start.line <= 3 && r.end.line >= 6), 'still on q1: its lines in view')
    assert.ok(noteById(left.q1Note.id)?.threadExpanded, 'q1 open with its grade')
    assert.equal(api.thread(left.q1Note.id)!.state, vscode.CommentThreadState.Unresolved, 'never collapsed as "resolved"')
    const graded = threadComments(left.q1Note.id).at(-1)!
    assert.ok(commentBody(graded).startsWith('✓ Right.'), commentBody(graded))
    assert.deepEqual(linksOf(graded).at(-1), { label: 'Next question ›', command: 'codeNotes.nextCheckQuestion', args: [] }, 'last: Next question')
  }),

  test('after the grade the thread\'s reply box is empty again', async () => {
    const replies = await (await ui()).evaluate(() => [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form .view-lines')].map((e: any) => e.textContent).join('|'))
    assert.ok(!replies.includes('the window starts over'), `the reply box is cleared: ${replies}`)
    await pageShot('check-1b-graded')
  }, devtools),

  test('"Next question ›" clicked in the thread', async () => {
    await (await ui()).locator('.review-widget .comment-body a', { hasText: 'Next question' }).first().click()
  }, devtools),

  test('"Next question ›" run as a command', async () => {
    await vscode.commands.executeCommand('codeNotes.nextCheckQuestion')
  }, withoutDevtools),

  test('"Next question ›" opens q2; the passed thread stays; a remark with markdown in it is shown as typed', async () => {
    await until('Next question opens q2', () => inLines(9, 11) && noteById(noteOf('q2').id)?.threadExpanded)
    assert.ok(api.thread(left.q1Note.id), 'the passed thread stays where it is')
    // No heading, no rule: as typed.
    await answer('q1', '# not a heading\n---\n<b>x</b> [link](https://example.com)')
    await until('the remark shown as typed', () => threadComments(left.q1Note.id).some((c) => /^\\# not a heading/.test(commentBody(c)) && commentBody(c).includes('\\[link\\]') && !(c.body as vscode.MarkdownString).supportHtml))
  }),

  test('q2 answered in the Check view\'s box (real keys, Ctrl+Enter): the same attempt as a thread reply', async () => {
    await until('focus in q2\'s box', async () => (await boxFocused()) === 'q2')
    await typeAnswer('Not sure.')
    await until('the answer in the thread too', () => noteOf('q2').messages.some((m: any) => m.role === 'human' && m.body === 'Not sure.'))
  }, devtools),

  test('q2 answered through its thread\'s reply', async () => {
    await answer('q2', 'Not sure.')
  }, withoutDevtools),

  test('a miss: "Not quite" and a hint in the thread', async () => {
    await until('q2: try again with a hint', () => /^Not quite[\s\S]*\*\*Hint:\*\*/.test(lastBody('q2')))
  }),

  test('after a grade that asks for more, the keyboard is back in the box by itself: what is typed next lands there', async () => {
    await until('after the retry grade: the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && view().answer?.grade && !view().answer!.checking)
    await (await ui()).keyboard.type('next try')
    assert.equal(await (await checkFrame()).locator('.answer textarea').inputValue(), 'next try', 'typed after the grade: in the box')
    await (await ui()).keyboard.press('Control+A'); await (await ui()).keyboard.press('Backspace')
  }, devtools),

  test('a miss keeps the editor on the question (nothing selected, its lines in view, thread open)', async () => {
    const editor = limitsEditor()!
    assert.ok(editor.selection.isEmpty, `nothing selected: ${JSON.stringify(editor.selection)}`); assert.ok(inLines(9, 11), 'on the question')
    assert.ok(editor.visibleRanges.some((r) => r.start.line <= 9 && r.end.line >= 11), 'the question\'s lines are in view')
    assert.ok(noteById(noteOf('q2').id)?.threadExpanded, 'the thread stays open')
    assert.equal(view().rows[1].word, 'try again')
    const { link } = await q2HintLink()
    assert.equal(link.label, 'the reset function', 'the hint names the code it links')
  }),

  test('the hint\'s code link clicked: it lights the reset function without moving the caret; keys typed next reach nothing', async () => {
    const limitsText = fs.readFileSync(limitsPath, 'utf8')
    await lightHintLink(async () => (await ui()).locator('.review-widget .comment-body a', { hasText: 'reset' }).first().click())
    await pageShot('check-2a-code-link')
    await typeAway('after a code link click', limitsText)
  }, devtools),

  test('the hint\'s code link run as a command: it lights the reset function without moving the caret', async () => {
    await lightHintLink(({ q2, hintAt }) => Promise.resolve(vscode.commands.executeCommand('codeNotes.codeLink', `check|${q2.id}|${hintAt}`, 0)))
  }, withoutDevtools),

  test('Back from a code link returns to the question', async () => {
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('back at the question', () => api.snapshot().tour.codeLinks.active === -1 && inLines(9, 11) && noteById(noteOf('q2').id)?.threadExpanded)
  }),

  test('after Back the keyboard is in q2\'s box: keys typed reach no code', async () => {
    const limitsText = fs.readFileSync(limitsPath, 'utf8')
    await until('Back: the keyboard in q2\'s box', async () => { const b = await boxFocused(); if (b !== 'q2') console.log('focus after Back:', b, await focusedElement()); return b === 'q2' })
    await typeAway('after Back', limitsText)
  }, devtools),

  test('the Check view\'s answer box: the keyboard is there on open; Ctrl+Enter answers; its grade\'s code link lights the code and keeps the keyboard; drafts survive switching; Esc goes back to the code', async () => {
    const limitsText = fs.readFileSync(limitsPath, 'utf8')
    // The grade under the box: its code link lights the code and the keyboard stays in the box.
    await until('the grade under the box', () => view().answer?.grade?.hint?.some((p: any) => p.link === 0))
    await pageShot('check-2b-box-grade')
    const frame = await checkFrame()
    await frame.locator('.answer .codelink', { hasText: 'the reset function' }).click()
    await until('lit from the view', () => api.snapshot().tour.codeLinks.active === 0)
    await until('the keyboard still in the box', async () => (await boxFocused()) === 'q2')
    await typeAway('after a code link in the view', limitsText)
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

  test('q2 answered a second time by keyboard, back in its box from q3', async () => {
    await vscode.commands.executeCommand('codeNotes.next')
    await until('on q3', () => view().answer?.id === 'q3')
    await vscode.commands.executeCommand('codeNotes.previous')
    await until('q2\'s box has the keyboard', async () => view().answer?.id === 'q2' && (await boxFocused()) === 'q2')
    await (await ui()).keyboard.press('Control+A')
    await typeAnswer('Still not sure.')
  }, devtools),

  test('q2 answered a second time through its thread\'s reply', async () => {
    await answer('q2', 'Still not sure.')
  }, withoutDevtools),

  test('a second miss: explained, "say it back"; the first wrong answer and its retry are not kept', async () => {
    await until('q2 explained', () => /Got it\? Say it back in one sentence/.test(lastBody('q2')))
    // Not in the file, not in the note.
    assert.equal(readCheck().questions[1].attempts[0].answer, undefined)
    // Nor its "Not quite" under it (it would talk about an answer no longer there); the explanation stays.
    await until('the first answer and its retry gone from the thread', () => !noteOf('q2').messages.some((m: any) => m.body === 'Not sure.' || /^Not quite/.test(m.body) || /not kept/.test(m.body)))
    assert.equal(view().rows[1].word, 'explained · say it back')
  }),

  test('after "explained" the keyboard is in q2\'s box: the restatement is typed with no click', async () => {
    await until('after "explained": the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && !view().answer?.checking)
    await typeAnswer(GOOD_Q2)
  }, devtools),

  test('the restatement through q2\'s thread reply', async () => {
    await answer('q2', GOOD_Q2)
  }, withoutDevtools),

  test('said back rightly: restated, counts as passed; the explanation stays', async () => {
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
]
