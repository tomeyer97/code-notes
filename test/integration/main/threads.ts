// Threads and anchors: an applied suggestion is recorded on its message and can't be applied twice, thread links are
// short (a screen reader reads a comment's Markdown as is), a stale note is tinted in the editor and its banner shows
// the old and the new line as text that wraps, and a move waits in the status bar (no notification) for Enter.
// Source: src/notes/suggestion.ts, src/platform/commands.ts (shortLinks), src/threads/, src/notes/decorations.ts,
// src/notes/move.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { appendMessage, now, quiet, readJson, test } from '../helpers'
import { agentNote, writeLines, writeNote } from '../fixtures'
import { cdp, ui } from '../devtools'
import { BARS, marksOf } from '../../../src/notes/decorations'
import { HiddenCmd } from '../../../src/platform/commands'
import { commandLinksIn, ctx, noteById, notePath, snap, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
const noteId = (tag: string) => `20261126-100000-${tag}`
const bodyOf = (c: vscode.Comment) => (typeof c.body === 'string' ? c.body : c.body.value)
const bodies = (id: string): string[] => (ctx.api.thread(id)?.comments ?? []).map(bodyOf)

/** The command links of a thread's comments, as a click runs them (a short link's own command and arguments). */
const links = (id: string) => bodies(id).flatMap(commandLinksIn)

/** The link a click on `[label](command:…)` runs, as VS Code runs it. */
const click = (l: { command: string; args: unknown[] }) => vscode.commands.executeCommand(l.command, ...l.args)

/** A file of the test's own, and a note by the person on line `line`, read, anchored on disk, with its thread. */
async function noteOn(tag: string, lines: string[], line: number, body = 'Why this?'): Promise<{ id: string; file: string; rel: string }> {
  const rel = `src/threads-${tag}.ts`
  writeLines(wsPath(rel), lines)
  const id = noteId(tag)
  writeNote(ctx.notesDir, id, { file: rel, range: { start: line, end: line }, status: 'open', messages: [{ author: snap().me, role: 'human', body }] })
  await until(`${id} anchored on disk`, () => readJson(notePath(id)).anchor?.text === lines[line - 1])
  await vscode.window.showTextDocument(vscode.Uri.file(wsPath(rel)))
  await until(`${id}'s thread`, () => ctx.api.thread(id))
  return { id, file: wsPath(rel), rel }
}

export const threadsTests = [
  test('Apply suggestion: recorded on the message in the note file, the link reads Applied ✓, a second Apply does nothing', async () => {
    const n = await noteOn('apply', ['export const a = 1', 'export const b = 2'], 2, 'Make b 3?')
    appendMessage(notePath(n.id), { author: 'claude', role: 'agent', body: 'Yes:\n\n```suggestion\nexport const b = 3\n```', at: now() })
    const apply = await until('the Apply link', () => links(n.id).find((l) => l.command === 'codeNotes.applySuggestion'))
    await click(apply)
    const doc = await vscode.workspace.openTextDocument(n.file)
    await until('applied', () => doc.lineAt(1).text === 'export const b = 3')
    const applied = readJson(notePath(n.id)).messages[1].applied
    assert.equal(applied?.length, 1, `the note file records it: ${JSON.stringify(readJson(notePath(n.id)).messages[1])}`)
    assert.deepEqual({ suggestion: applied[0].suggestion, by: applied[0].by }, { suggestion: 0, by: snap().me })
    await until('the link reads Applied ✓', () => bodies(n.id).some((b) => b.includes('Applied ✓')) && !links(n.id).some((l) => l.command === 'codeNotes.applySuggestion'))
    // Clicked again (a link drawn before): nothing changes.
    assert.equal(await ctx.api.applySuggestion(n.id, 1, 0), false)
    await quiet(500, 'a second copy of the suggestion')
    assert.equal(doc.getText(), 'export const a = 1\nexport const b = 3\n')
    assert.equal(readJson(notePath(n.id)).messages[1].applied.length, 1)
    await doc.save()
  }),

  test('thread links hold no percent-encoded JSON; a short link runs its command (a root file:line opens it)', async () => {
    writeLines(wsPath('tool.json'), ['{', '  "a": 1,', '  "b": 2', '}'])
    const n = await noteOn('links', ['export const c = 1'], 1)
    appendMessage(notePath(n.id), { author: 'claude', role: 'agent', body: 'See tool.json:3 and src/app.ts:2.', at: now() })
    const open = await until('the answer\'s links', () => {
      const l = links(n.id).filter((x) => x.command === 'codeNotes.openAt')
      return l.length === 2 ? l : undefined
    })
    for (const b of bodies(n.id)) assert.doesNotMatch(b, /%5B|%22|%7B/, `no percent-encoded JSON in a comment: ${b}`)
    assert.ok(bodies(n.id).some((b) => /\[tool\.json:3\]\(command:codeNotes\.link\?\d{6}\)/.test(b)), bodies(n.id).join('\n'))
    await click(open[0])
    await until('tool.json open at line 3', () => vscode.window.activeTextEditor?.document.uri.fsPath === wsPath('tool.json')
      && vscode.window.activeTextEditor.selection.active.line === 2)
    const all = await vscode.commands.getCommands(true)
    for (const c of [HiddenCmd.link, HiddenCmd.concernFix, HiddenCmd.concernTodo, HiddenCmd.concernFlag, HiddenCmd.concernFixed, HiddenCmd.concernDismiss]) {
      assert.ok(all.includes(c), `${c} is registered (the concern's actions on its thread)`)
    }
  }),

  test('a stale note: its lines tinted and marked in the ruler; the banner shows the old and the new line, wrapped', async () => {
    const was = '// The error the person must see is shown as an error (a toast), not a log line.'
    const n = await noteOn('stale', ['export function run() {', was, '}'], 2)
    fs.writeFileSync(n.file, ['export function run() {', '// The failure the user has to notice is surfaced (a toast), not a log line.', '}', ''].join('\n'))
    await until('stale', () => noteById(n.id)?.stale === true)
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(n.file))
    await until('the stale tint on line 2', () => marksOf(editor).staleBar.some((r) => r.start.line === 1))
    assert.deepEqual(marksOf(editor).openBar.filter((r) => r.start.line === 1), [], 'not marked as an open note')
    assert.equal(BARS.staleBar.background, 'codeNotes.staleBackground')
    assert.equal(BARS.staleBar.ruler, 'editorWarning.foreground')
    const banner = await until('the banner with − old / + new', () => bodies(n.id).find((b) => b.includes('The code changed since this note') && b.includes('\\+ ')))
    assert.ok(!banner.includes('```'), `no code block (it scrolls sideways): ${banner}`)
    assert.match(banner, /− \/\/ The `error` the `person must see` is `shown as an error`/)
    assert.match(banner, /\\\+ \/\/ The `failure` the `user has to notice` is `surfaced`/)
  }),

  test('Move: the status bar item waits for the selection, no notification; Enter (moveToSelection without a note) moves it', async () => {
    const n = await noteOn('move', ['const one = 1', 'const two = 2', 'const three = 3', 'const four = 4'], 1)
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(n.file))
    editor.selection = new vscode.Selection(0, 0, 0, 0)
    await vscode.commands.executeCommand('codeNotes.moveToSelection', n.id)
    if (cdp) {
      const page = await ui()
      await until('Move note here in the status bar', async () => (await page.locator('.statusbar-item', { hasText: 'Move note here' }).count()) > 0)
      assert.equal(await page.locator('.notification-toast', { hasText: /Move/ }).count(), 0, 'no notification')
    }
    editor.selection = new vscode.Selection(2, 0, 3, 14)
    await vscode.commands.executeCommand('codeNotes.moveToSelection') // Enter's binding passes no note
    await until('moved to lines 3-4', () => noteById(n.id)?.range?.start === 3 && noteById(n.id).range.end === 4)
    assert.equal(readJson(notePath(n.id)).range.start, 3)
  }),
]
