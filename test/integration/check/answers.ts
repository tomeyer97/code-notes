// Answering: a good answer typed in the thread's reply box, a miss with a hint and its code link, the Check view's
// answer box (keyboard, drafts, Esc), explained and said back, the grader's concern (flag, TODO).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { quiet, settle, test, untilEqual } from '../helpers'
import { boxFocused, cdp, checkFrame, focusedElement, pageShot, ui } from '../devtools'
import { CHECK_WAIT_MS, api, answer, clickLinkOr, codeEditor, commentBody, devtools, inLines, lastBody, left, limitsEditor, limitsPath, noteById, noteOf, readCheck, threadComments, typeAnswer, until, view, ws } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

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

export const answersTests = [
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
    assert.ok(noteById(left.q1Note.id)?.threadExpanded, 'q1 open with its grade')
    assert.equal(api.thread(left.q1Note.id)!.state, vscode.CommentThreadState.Unresolved, 'never collapsed as "resolved"')
    const graded = threadComments(left.q1Note.id).at(-1)!.body as vscode.MarkdownString
    assert.match(graded.value, /^✓ Right\.[\s\S]*\[Next question ›\]\(command:codeNotes\.nextCheckQuestion\)$/)
    if (cdp) {
      const page = await ui()
      const replies = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form .view-lines')].map((e: any) => e.textContent).join('|'))
      assert.ok(!replies.includes('the window starts over'), `the reply box is cleared: ${replies}`)
      await pageShot('check-1b-graded')
    }
    await clickLinkOr('Next question', () => vscode.commands.executeCommand('codeNotes.nextCheckQuestion'))
    await until('Next question opens q2', () => inLines(9, 11) && noteById(noteOf('q2').id)?.threadExpanded)
    assert.ok(api.thread(left.q1Note.id), 'the passed thread stays where it is')
    // A remark on a passed question with markdown in it: shown as typed in the thread (no heading, no rule).
    await answer('q1', '# not a heading\n---\n<b>x</b> [link](https://example.com)')
    await until('the remark shown as typed', () => threadComments(left.q1Note.id).some((c) => /^\\# not a heading/.test(commentBody(c)) && commentBody(c).includes('\\[link\\]') && !(c.body as vscode.MarkdownString).supportHtml))
  }),

  // One behaviour in three tests: the miss (here), the answer box in between (DevTools), then explained and restated.
  test('a miss keeps the editor on the question (nothing selected, thread open); the hint\'s code link lights the reset function and Back returns', async () => {
    if (cdp) {
      // Answered in the Check view's box: real keys, Ctrl+Enter; the same attempt as a thread reply.
      await until('focus in q2\'s box', async () => (await boxFocused()) === 'q2')
      await typeAnswer('Not sure.')
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
    await clickLinkOr('reset', () => vscode.commands.executeCommand('codeNotes.codeLink', `check|${q2.id}|${hintAt}`, 0))
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
      await (await ui()).keyboard.press('Control+A')
      await typeAnswer('Still not sure.')
    } else await answer('q2', 'Still not sure.')
    await until('q2 explained', () => /Got it\? Say it back in one sentence/.test(lastBody('q2')))
    // The first wrong answer is not kept: not in the file, not in the note.
    assert.equal(readCheck().questions[1].attempts[0].answer, undefined)
    // Nor its "Not quite" under it (it would talk about an answer no longer there); the explanation stays.
    await until('the first answer and its retry gone from the thread', () => !noteOf('q2').messages.some((m: any) => m.body === 'Not sure.' || /^Not quite/.test(m.body) || /not kept/.test(m.body)))
    assert.equal(view().rows[1].word, 'explained · say it back')
    if (cdp) {
      await until('after "explained": the keyboard in q2\'s box', async () => (await boxFocused()) === 'q2' && !view().answer?.checking)
      await typeAnswer('GOOD: the counts are per customer, so splitting orders does not help.')
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
]
