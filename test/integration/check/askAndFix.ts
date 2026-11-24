// Claude on a check question: Ask Claude (a separate note), Suggest a fix (Apply, Undo), a concern dismissed.
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { test } from '../helpers'
import { pageShot } from '../devtools'
import { api, ciOutput, git, left, limitsPath, noteById, noteOf, readCheck, threadComments, until, untilButtonShown, view } from './context'
import { fixNoteFor, linksOf, noteAskedFrom } from './support'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const askAndFixTests = [
  test('Ask Claude on a check question: a separate note on the same lines, the check thread unchanged', async () => {
    const before = noteOf('q1').messages.length
    await vscode.commands.executeCommand('codeNotes.askClaude', { thread: api.thread(noteOf('q1').id), text: 'What does counts hold?' })
    const asked = await until('a separate note', () => noteAskedFrom('q1'))
    assert.equal(asked.messages[0]?.body, 'What does counts hold?')
    assert.equal(asked.session, undefined, 'not one of the check\'s threads')
    assert.equal(noteOf('q1').messages.length, before)
    assert.ok((api.snapshot().tree() as string[]).some((l) => l.includes('What does counts hold?')), 'a note asked from a question is listed')
    // branches.ts looks for it on another branch.
    left.askedNote = asked
  }),

  test('Suggest a fix: a note asked to Claude; one sentence and a suggestion; Apply puts it in ("fix applied · not committed", offered with Commit & push), Undo takes it back', async () => {
    const limitsBefore = fs.readFileSync(limitsPath, 'utf8')
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'fix')
    const fix = await until('a fix note', () => fixNoteFor('q3'))
    left.fixNote = fix
    assert.match(fix.messages[0].body, /^Suggest a fix: api\/limits\.js:2 keeps counts in memory/)
    const suggestion = await until('Claude suggests', () => noteById(fix.id)?.messages.find((m: any) => m.author === 'Claude'))
    assert.match(suggestion.body, /^Keep the counts somewhere that survives a restart\.\n\n```suggestion\n/)
    const fixLinks = () => ((api.thread(fix.id)?.comments ?? []) as vscode.Comment[]).flatMap(linksOf)
    const apply = await until('an Apply link', () => fixLinks().find((l) => l.label === 'Apply suggestion' && l.command === 'codeNotes.applySuggestion'))
    await pageShot('check-6-suggest-fix')
    await vscode.commands.executeCommand(apply.command, ...apply.args)
    const limitsDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === limitsPath)!
    await until('applied', () => limitsDoc.getText().startsWith('// FIXED: counts survive a restart\n'))
    // Said on its question and offered (ticked) with Commit & push, although the check file is pushed.
    await until('the applied fix offered', () => view()?.action?.label === 'Commit & push' && view().line === 'Your fix is not committed yet.' && view().rows[2].flag === 'fix applied · not committed' && view().also?.some((x: any) => x.label === 'limits.js (your fix)' && x.on))
    await untilButtonShown('Commit & push on screen with the fix', 'Commit & push')
    await pageShot('check-6b-fix-applied')
    await vscode.window.showTextDocument(limitsDoc)
    await vscode.commands.executeCommand('undo')
    await until('undone', () => limitsDoc.getText() === limitsBefore)
    if (limitsDoc.isDirty) await limitsDoc.save()
    await until('undone: nothing left to commit', () => view()?.line === 'Pushed.' && !view().action)
  }),

  test('a concern dismissed with a reason (Dismiss, beside Mark fixed): kept in the file, gone from the thread, the row and the merge request', async () => {
    const actions = threadComments(noteOf('q3').id).flatMap(linksOf).filter((l) => l.command === 'codeNotes.checkConcern').map((l) => `${l.label}:${l.args[1]}`)
    assert.deepEqual(actions.slice(-2), ['Mark fixed:fixed', 'Dismiss:dismiss'], `the quiet actions, Dismiss beside Mark fixed: ${actions}`)
    await vscode.commands.executeCommand('codeNotes.checkConcern', noteOf('q3').id, 'dismiss', 'A restart is fine: counts are per hour anyway.')
    await until('dismissed', () => readCheck().questions[2].concern?.dismissed?.reason === 'A restart is fine: counts are per hour anyway.' && readCheck().questions[2].concern.flagged === false && !view().rows[2].flag)
    await until('gone from the thread', () => !threadComments(noteOf('q3').id).some((c) => /Found while grading/.test(String((c.author as any)?.name))))
    assert.doesNotMatch(ciOutput(), /restart lets everyone/)
    git('commit', '-qam', 'dismissed')
  }),
]
